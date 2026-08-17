import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	TurnStartEvent,
	TurnEndEvent,
	MessageUpdateEvent,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// ── per-model segment ── (bounded: 200 samples keep memory + median responsive)
	const MAX_SAMPLES = 200;
	let tpsValues: number[] = [];
	let effTpsValues: number[] = [];
	let ttftValues: number[] = [];
	const push = (arr: number[], v: number): void => {
		arr.push(v);
		if (arr.length > MAX_SAMPLES) arr.shift();
	};

	// ── current-turn tracking ──
	let turnStart = 0;
	let textStart = 0;
	let pushedEff = false;

	function median(sorted: number[]): number {
		if (sorted.length === 0) return 0;
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 === 1
			? sorted[mid]
			: (sorted[mid - 1] + sorted[mid]) / 2;
	}

	// ponytail: provider token counts may lump thinking into output. Align numerator
	// to the measured window: subtract reasoning tokens when reported, else estimate
	// text tokens from content blocks (chars/4).
	function textTokensOf(message: any): number {
		const usage = message.usage;
		if (!usage || typeof usage.output !== "number" || usage.output <= 0)
			return 0;
		if (typeof usage.reasoning === "number" && usage.reasoning >= 0) {
			return Math.max(0, usage.output - usage.reasoning);
		}
		const text = (message.content ?? [])
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("");
		return Math.ceil(text.length / 4);
	}

	function fmtDur(ms: number): string {
		if (ms < 10000) return `${(ms / 1000).toFixed(1).replace(".", ",")}s`;
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		return `${Math.floor(s / 60)}m ${s % 60}s`;
	}

	// ponytail: color by speed — <=40 red, <=80 yellow, <=100 white, >=100 green
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
		const n = tpsValues.length;
		if (n === 0) {
			ctx.ui.setStatus("tps", undefined);
			return;
		}

		const med = median([...tpsValues].sort((a, b) => a - b));
		const t = ctx.ui.theme;
		// ponytail: value first, label after — matches requested `xxx t/s` layout
		let text = `${t.fg("dim", "med")} ${tpsColored(t, med)} ${t.fg("dim", "t/s")}`;

		if (ttftValues.length > 0) {
			const avgTTFT = ttftValues.reduce((a, b) => a + b, 0) / ttftValues.length;
			text += ` | ${t.fg("warning", fmtDur(avgTTFT))} ${t.fg("dim", "ttft")}`;
		}

		ctx.ui.setStatus("tps", text);
	}

	function resetStats(ctx: ExtensionContext, modelLabel: string) {
		// F1: measure BEFORE clearing — otherwise the flash branch is dead code.
		const hadSamples = tpsValues.length > 0 || effTpsValues.length > 0 || ttftValues.length > 0;
		tpsValues = [];
		effTpsValues = [];
		ttftValues = [];
		turnStart = 0;
		textStart = 0;
		pushedEff = false;
		if (!hadSamples) {
			ctx.ui.setStatus("tps", undefined);
			return;
		}
		const t = ctx.ui.theme;
		ctx.ui.setStatus(
			"tps",
			`${t.fg("dim", "t/s reset")} ${t.fg("accent", modelLabel)}`,
		);
		setTimeout(() => {
			if (tpsValues.length === 0 && effTpsValues.length === 0 && ttftValues.length === 0) ctx.ui.setStatus("tps", undefined);
		}, 2000);
	}

	pi.on("turn_start", (_event: TurnStartEvent, ctx: ExtensionContext) => {
		turnStart = Date.now();
		textStart = 0;
		pushedEff = false;
	});

	pi.on(
		"message_update",
		(event: MessageUpdateEvent, _ctx: ExtensionContext) => {
			if (!turnStart) return;
			const ev = event.assistantMessageEvent;
			if (ev?.type === "text_start" && textStart === 0) {
				textStart = Date.now();
			}
		},
	);

	pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
		if (event.message.role !== "assistant") return;
		if (!turnStart) return;

		const now = Date.now();
		const usage = event.message.usage;
		if (!usage || typeof usage.output !== "number" || usage.output <= 0) return;

		// text-window math is only valid for segments that streamed text
		// (thinking-only / tool-call-only segments never fire text_start)
		if (textStart !== 0) {
			const ttft = textStart - turnStart;
			if (ttft >= 0) push(ttftValues, ttft);

			// streaming t/s: text tokens streamed inside [text_start, message_end]
			const textTokens = textTokensOf(event.message);
			const durationMs = now - textStart;
			if (durationMs > 0 && textTokens > 0) {
				push(tpsValues, textTokens / (durationMs / 1000));
			}
		}

		// effective t/s: all output tokens over the full turn (incl. thinking time);
		// recorded for every segment so tool-only segments aren't dropped from the set
		const effDurationMs = now - turnStart;
		if (effDurationMs > 0) {
			push(effTpsValues, usage.output / (effDurationMs / 1000));
			pushedEff = true;
		}

		// pi fires turn_start/turn_end per assistant message: keep turnStart across
		// a segment's streaming; effTps is recorded per segment at message_end.
		textStart = 0;
		updateStatus(ctx);
	});

	// M1: finalize effective t/s once per full turn (final answer included).
	pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
		if (!turnStart) return;
		const usage = (event.message as AssistantMessage)?.usage;
		if (usage && typeof usage.output === "number" && usage.output > 0) {
			const effDurationMs = Date.now() - turnStart;
			if (effDurationMs > 0) {
				const effTps = usage.output / (effDurationMs / 1000);
				if (pushedEff) {
					// F2: message_end already pushed this segment — replace, not append.
					effTpsValues[effTpsValues.length - 1] = effTps;
				} else {
					// this segment recorded no effTps — append fresh instead of
					// clobbering the previous segment's sample (or writing arr[-1])
					push(effTpsValues, effTps);
				}
			}
		}
		pushedEff = false;
		turnStart = 0;
		textStart = 0;
		updateStatus(ctx);
	});

	pi.on("model_select", (event: { model: { provider: string; id: string } }, ctx: ExtensionContext) => {
		const modelLabel = `${event.model.provider}/${event.model.id}`;
		// ponytail: reset stats on model change — different models have different speeds
		resetStats(ctx, modelLabel);
	});

	// ── detail via /tps-stats command ──
	pi.registerCommand("tps-stats", {
		description: "Show token-per-second statistics for current model",
		handler: async (_args, ctx) => {
			const n = tpsValues.length;
			if (n === 0) {
				ctx.ui.notify("t/s Stats: no data yet. Send a prompt first.", "info");
				return;
			}
			const avg = tpsValues.reduce((a, b) => a + b, 0) / n;
			const sorted = [...tpsValues].sort((a, b) => a - b);
			const med = median(sorted);
			const min = sorted[0];
			const max = sorted[n - 1];

			const lines = [
				`Streaming t/s (text tokens / text window)`,
				`Samples: ${n}`,
				`Average: ${avg.toFixed(1)}`,
				`Median:  ${med.toFixed(1)}`,
				`Min:     ${min.toFixed(1)}`,
				`Max:     ${max.toFixed(1)}`,
			];

			if (effTpsValues.length > 0) {
				const effAvg =
					effTpsValues.reduce((a, b) => a + b, 0) / effTpsValues.length;
				const effMed = median([...effTpsValues].sort((a, b) => a - b));
				lines.push(
					`---`,
					`Effective t/s (all tokens / full turn):`,
					`Average: ${effAvg.toFixed(1)}`,
					`Median:  ${effMed.toFixed(1)}`,
				);
			}

			if (ttftValues.length > 0) {
				const avgTTFT =
					ttftValues.reduce((a, b) => a + b, 0) / ttftValues.length;
				const sortedTTFT = [...ttftValues].sort((a, b) => a - b);
				const medTTFT = median(sortedTTFT);
				lines.push(
					`---`,
					`TTFT avg:   ${fmtDur(avgTTFT)}`,
					`TTFT median: ${fmtDur(medTTFT)}`,
				);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
