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
 * Effective response t/s = all output tokens over the assistant response,
 * from turn start through message end. This includes queue, prefill, and TTFT,
 * but excludes tool execution, which happens after message end.
 *
 * There is deliberately only one rate here. The obvious alternative — divide by
 * the stream window, from first chunk to last — does not survive contact with
 * real providers, because SSE arrival times measure the gateway's flush
 * schedule, not the model's generation speed. Measured against
 * vantis/deepseek-v4-flash-0731-fast, median inter-chunk gap is 0.01ms: chunks
 * land in instant batches separated by long pauses, so the "window" is an
 * artifact of how many batch boundaries happened to fall inside it:
 *
 *     prompt              turn      window-based    this function
 *     "Say OK."           1.40s        263 t/s          41 t/s
 *     "List 3 fruits."    8.81s        801 t/s          14 t/s
 *     900-word essay     18.49s         89 t/s          55 t/s
 *
 * The window-based column swings 9x on one model in one minute; this one stays
 * in a plausible band. Earlier versions shipped the window math and reported
 * four-digit rates (1777, 1490) that no local model could reach.
 *
 * `usage.output` counts thinking + text + tool-call arguments, so numerator and
 * denominator describe one assistant response. Queue and prefill latency are
 * included: this is the rate you actually wait for, which is why it reads
 * lower than a provider's marketing number. Tool execution is not included.
 */
export function tps(
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
	let tpsValues: number[] = [];
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
		if (tpsValues.length === 0) {
			ctx.ui.setStatus("tps", undefined);
			return;
		}
		const t = ctx.ui.theme;
		let text = `${t.fg("dim", "eff")} ${tpsColored(t, median(tpsValues))} ${t.fg("dim", "t/s")}`;
		if (ttftValues.length > 0) {
			text += ` | ${t.fg("warning", fmtDur(median(ttftValues)))} ${t.fg("dim", "ttft")}`;
		}
		ctx.ui.setStatus("tps", text);
	}

	function resetStats(ctx: ExtensionContext, modelLabel: string) {
		// measure BEFORE clearing, else the flash branch is dead code
		const hadSamples = tpsValues.length > 0 || ttftValues.length > 0;
		tpsValues = [];
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
			if (tpsValues.length === 0) ctx.ui.setStatus("tps", undefined);
		}, 2000);
	}

	pi.on("turn_start", (event: TurnStartEvent, _ctx: ExtensionContext) => {
		turnStart = event.timestamp;
		streamStart = 0;
	});

	// TTFT only — the first token's arrival is a real observation. Where the
	// *rest* of the chunks land is the gateway's flush schedule, so no rate is
	// derived from them.
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
		}

		const rate = tps(output, turnStart, now);
		if (rate !== undefined) push(tpsValues, rate);

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
			const n = tpsValues.length;
			if (n === 0) {
				ctx.ui.notify("t/s Stats: no data yet. Send a prompt first.", "info");
				return;
			}
			const sorted = [...tpsValues].sort((a, b) => a - b);
			const lines = [
				"effective t/s (output tokens / assistant response, prefill included)",
				`Samples: ${n}`,
				`Average: ${mean(tpsValues).toFixed(1)}`,
				`Median:  ${median(tpsValues).toFixed(1)}`,
				`Min:     ${sorted[0].toFixed(1)}`,
				`Max:     ${sorted[n - 1].toFixed(1)}`,
			];
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
