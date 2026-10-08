import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { isTalking, SubagentsWidget } from "./format.ts";
import { type RunSnapshot, TERMINAL } from "./types.ts";

const THROTTLE_MS = 150;
const PULSE_MS = 700;

/**
 * The live-runs widget above the editor: throttled redraws per run, a pulse while a child is
 * talking, and settled runs pruned (subagent_status/result still reach them — this shows live work).
 */
export class RunWidget {
	runs: RunSnapshot[] = [];
	private tui: TUI | null = null;
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private pulseTimer: ReturnType<typeof setTimeout> | null = null;

	/** Remove the widget from the UI; pending timers keep running and re-create it on demand. */
	clear(ctx?: ExtensionContext): void {
		this.runs = [];
		this.tui = null;
		if (ctx?.hasUI) {
			try {
				ctx.ui.setWidget("subagents", undefined);
			} catch {}
		}
	}

	/** Session end: drop every timer and run without touching the UI. */
	dispose(): void {
		this.tui = null;
		if (this.pulseTimer) {
			clearTimeout(this.pulseTimer);
			this.pulseTimer = null;
		}
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.runs = [];
	}

	upsert(run: RunSnapshot | undefined): void {
		this.prune();
		if (!run || TERMINAL.includes(run.status)) return;
		const idx = this.runs.findIndex((r) => r.id === run.id);
		if (idx >= 0) this.runs[idx] = run;
		else this.runs.push(run);
	}

	schedule(run: RunSnapshot | undefined, ctx?: ExtensionContext): void {
		this.upsert(run);
		if (!run || this.timers.has(run.id)) return;
		this.timers.set(
			run.id,
			setTimeout(() => {
				this.timers.delete(run.id);
				if (ctx?.hasUI) {
					this.ensure(ctx);
					this.tui?.requestRender();
				}
				this.maybePulse(ctx);
			}, THROTTLE_MS),
		);
	}

	flush(run: RunSnapshot | undefined, ctx?: ExtensionContext, onUpdate?: (partial: any) => void): void {
		if (run) {
			const timer = this.timers.get(run.id);
			if (timer) {
				clearTimeout(timer);
				this.timers.delete(run.id);
			}
		}
		this.prune();
		if (this.runs.length === 0) {
			if (this.tui) this.clear(ctx);
		} else {
			if (ctx?.hasUI) {
				this.ensure(ctx);
				this.tui?.requestRender();
			}
			this.maybePulse(ctx);
		}
		if (!run) return;

		onUpdate?.({
			content: [
				{
					type: "text",
					text: `${run.tasks.filter((t) => TERMINAL.includes(t.status)).length}/${run.tasks.length} done · ${run.status}`,
				},
			],
		});
	}

	private prune(): void {
		this.runs = this.runs.filter((r) => !TERMINAL.includes(r.status));
	}

	private maybePulse(ctx?: ExtensionContext): void {
		if (this.pulseTimer || !this.tui) return;
		const talking = this.runs.some((r) => r.tasks.some(isTalking));
		if (!talking) return;
		this.pulseTimer = setTimeout(() => {
			this.pulseTimer = null;
			this.tui?.requestRender();
			this.maybePulse(ctx);
		}, PULSE_MS);
	}

	private ensure(ctx: ExtensionContext): void {
		if (this.tui !== null || !ctx.hasUI) return;
		ctx.ui.setWidget(
			"subagents",
			(tui, theme) => {
				this.tui = tui;
				return new SubagentsWidget(() => [...this.runs], theme);
			},
			{ placement: "aboveEditor" },
		);
	}
}
