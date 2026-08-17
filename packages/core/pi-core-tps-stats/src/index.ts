import type {
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	MessageUpdateEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

// ModelSelectEvent is declared in pi-coding-agent but not re-exported from its
// entrypoint; only these two fields are used, so structural typing is enough.
type ModelSelectEvent = { model: { provider: string; id: string } };

// ── pure math (exported for src/index.test.ts) ──

/** bounded ring: keep the newest MAX_SAMPLES values */
export const MAX_SAMPLES = 200;

export function push(arr: number[], v: number): void {
	arr.push(v);
	if (arr.length > MAX_SAMPLES) arr.shift();
}

export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * A stream window shorter than this is not a stream — it is a buffered response
 * delivered in one burst, and no generation rate can be recovered from it.
 *
 * Some gateways (vantis deepseek-v4-flash-0731-fast, measured) hold the whole
 * completion server-side, then flush every chunk within a millisecond of the
 * first. Dividing hundreds of tokens by that window yields four-digit t/s.
 * ponytail: a flat floor, not an adaptive heuristic. Ceiling: a genuinely
 * sub-100ms real stream is discarded too, which needs ~1000 t/s to happen.
 */
export const MIN_STREAM_MS = 100;

/**
 * Generation t/s = every output token over the window they actually streamed in.
 *
 * `usage.output` counts thinking + text + tool-call argument tokens, so the
 * denominator must be the whole content stream, not just the text sub-window.
 * Pairing `output - reasoning` with a text-only window (the old math) divided a
 * numerator that still held tool-call tokens by a window that excluded thinking
 * time — measured 4x-163x inflation on deepseek-v4-flash, e.g. a bogus 1777 t/s.
 *
 * Returns undefined when the response never really streamed; callers fall back
 * to effective t/s, which stays meaningful because its window is the full turn.
 */
export function genTps(
	outputTokens: number,
	streamStartMs: number,
	endMs: number,
): number | undefined {
	const durationMs = endMs - streamStartMs;
	if (outputTokens <= 0 || durationMs < MIN_STREAM_MS) return undefined;
	return outputTokens / (durationMs / 1000);
}

/** Effective t/s = output tokens over the full turn, prefill/queue latency included. */
export function effTps(
	outputTokens: number,
	turnStartMs: number,
	endMs: number,
): number | undefined {
	const durationMs = endMs - turnStartMs;
	if (outputTokens <= 0 || durationMs <= 0) return undefined;
	return outputTokens / (durationMs / 1000);
}

export function fmtDur(ms: number): string {
	if (ms < 10000) return `${(ms / 1000).toFixed(1).replace(".", ",")}s`;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** first stream event of any kind — thinking counts, it is generated tokens too */
const CONTENT_START_EVENTS = new Set([
	"text_start",
	"thinking_start",
	"toolcall_start",
]);

export default function (pi: ExtensionAPI) {
	let genValues: number[] = [];
	let effValues: number[] = [];
	let ttftValues: number[] = [];

	let turnStart = 0;
	let streamStart = 0;
	let resetTimer: ReturnType<typeof setTimeout> | undefined;

	// ponytail: color by speed — <=40 red, <=80 yellow, <100 white, >=100 green
	function tpsColored(
		t: { fg(color: string, text: string): string },
		v: number,
	): string {
		const s = String(Math.round(v));
		if (v <= 40) return t.fg("error", s);
		if (v <= 80) return t.fg("warning", s);
		if (v < 100) return t.fg("text", s);
		return t.fg("success", s);
	}

	function updateStatus(ctx: ExtensionContext) {
		// buffered (non-streaming) providers produce no generation samples at all;
		// effective t/s is then the only honest rate, so label it as such
		const buffered = genValues.length === 0;
		const values = buffered ? effValues : genValues;
		if (values.length === 0) {
			ctx.ui.setStatus("tps", undefined);
			return;
		}
		const t = ctx.ui.theme;
		let text = `${t.fg("dim", buffered ? "eff" : "med")} ${tpsColored(t, median(values))} ${t.fg("dim", "t/s")}`;
		if (ttftValues.length > 0) {
			text += ` | ${t.fg("warning", fmtDur(median(ttftValues)))} ${t.fg("dim", "ttft")}`;
		}
		ctx.ui.setStatus("tps", text);
	}

	function resetStats(ctx: ExtensionContext, modelLabel: string) {
		// measure BEFORE clearing, else the flash branch is dead code
		const hadSamples =
			genValues.length > 0 || effValues.length > 0 || ttftValues.length > 0;
		genValues = [];
		effValues = [];
		ttftValues = [];
		turnStart = 0;
		streamStart = 0;
		clearTimeout(resetTimer);
		if (!hadSamples) {
			ctx.ui.setStatus("tps", undefined);
			return;
		}
		const t = ctx.ui.theme;
		ctx.ui.setStatus(
			"tps",
			`${t.fg("dim", "t/s reset")} ${t.fg("accent", modelLabel)}`,
		);
		resetTimer = setTimeout(() => {
			if (genValues.length === 0 && effValues.length === 0)
				ctx.ui.setStatus("tps", undefined);
		}, 2000);
	}

	pi.on("turn_start", (_event: TurnStartEvent, _ctx: ExtensionContext) => {
		turnStart = Date.now();
		streamStart = 0;
	});

	pi.on(
		"message_update",
		(event: MessageUpdateEvent, _ctx: ExtensionContext) => {
			if (!turnStart || streamStart !== 0) return;
			if (CONTENT_START_EVENTS.has(event.assistantMessageEvent?.type)) {
				streamStart = Date.now();
			}
		},
	);

	pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
		if (event.message.role !== "assistant") return;
		if (!turnStart) return;

		const now = Date.now();
		const output = event.message.usage?.output;
		if (typeof output !== "number" || output <= 0) return;

		if (streamStart !== 0) {
			const ttft = streamStart - turnStart;
			if (ttft >= 0) push(ttftValues, ttft);
			// undefined when the provider buffered the response — see MIN_STREAM_MS
			const gen = genTps(output, streamStart, now);
			if (gen !== undefined) push(genValues, gen);
		}

		const eff = effTps(output, turnStart, now);
		if (eff !== undefined) push(effValues, eff);

		// pi's agent loop emits one assistant message per turn and re-fires
		// turn_start for the next one, so message_end is the only place stats
		// need recording — no turn_end reconciliation.
		turnStart = 0;
		streamStart = 0;
		updateStatus(ctx);
	});

	pi.on("model_select", (event: ModelSelectEvent, ctx: ExtensionContext) => {
		// ponytail: reset on model change — different models, different speeds
		resetStats(ctx, `${event.model.provider}/${event.model.id}`);
	});

	pi.registerCommand("tps-stats", {
		description: "Show token-per-second statistics for current model",
		handler: async (_args, ctx) => {
			const n = genValues.length;
			if (n === 0 && effValues.length === 0) {
				ctx.ui.notify("t/s Stats: no data yet. Send a prompt first.", "info");
				return;
			}
			const lines: string[] = [];
			if (n === 0) {
				lines.push(
					"Generation t/s: unavailable — this provider buffers the whole",
					`response and flushes it in under ${MIN_STREAM_MS}ms, so there is no`,
					"stream window to measure. Effective t/s below is the real rate.",
				);
			} else {
				const sorted = [...genValues].sort((a, b) => a - b);
				lines.push(
					"Generation t/s (all output tokens / stream window)",
					`Samples: ${n}`,
					`Average: ${mean(genValues).toFixed(1)}`,
					`Median:  ${median(genValues).toFixed(1)}`,
					`Min:     ${sorted[0].toFixed(1)}`,
					`Max:     ${sorted[n - 1].toFixed(1)}`,
				);
			}
			if (effValues.length > 0) {
				lines.push(
					"---",
					"Effective t/s (all output tokens / full turn, prefill included):",
					`Average: ${mean(effValues).toFixed(1)}`,
					`Median:  ${median(effValues).toFixed(1)}`,
				);
			}
			if (ttftValues.length > 0) {
				lines.push(
					"---",
					`TTFT avg:    ${fmtDur(mean(ttftValues))}`,
					`TTFT median: ${fmtDur(median(ttftValues))}`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
