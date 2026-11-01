import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { readSubagentConfig, writeSubagentConfig } from "./config.ts";
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
	collapsed = readSubagentConfig().widgetCollapsed === true;
	showAll = false;
	/** Set by the extension: opens a task's session view. */
	onOpen: ((taskId: string) => void) | undefined;
	private component: SubagentsWidget | undefined;
	/** Keyboard highlight in the widget; undefined while the editor owns the arrows. */
	selected: number | undefined;

	/**
	 * Leader editor key hook. With the editor empty, ↓ moves into the widget rows; while a row is
	 * highlighted ↑↓ move, Enter opens it (or expands `+N more`), Esc gives the arrows back.
	 */
	handleKey(data: string, editorEmpty: boolean): boolean {
		// Peek, the session view and dialogs own the keyboard while open.
		if (this.tui?.hasOverlay()) return false;
		// Kitty terminals also report key releases, and input listeners see them before pi drops them;
		// swallow the release of a key we handled, or one press moves two rows.
		if (isKeyRelease(data)) return this.selected !== undefined;
		const rows = this.component?.selectable() ?? [];
		if (this.selected === undefined) {
			if (!editorEmpty || rows.length === 0 || !matchesKey(data, Key.down)) return false;
			// Land on the first subagent; ↑ from there reaches the header.
			this.selected = rows.length > 1 ? 1 : 0;
		} else if (rows.length === 0 || matchesKey(data, Key.escape)) {
			this.selected = undefined;
		} else if (matchesKey(data, Key.down)) {
			this.selected = Math.min(rows.length - 1, this.selected + 1);
		} else if (matchesKey(data, Key.up)) {
			this.selected = this.selected === 0 ? undefined : this.selected - 1;
		} else if (matchesKey(data, Key.enter)) {
			const row = rows[Math.min(this.selected, rows.length - 1)];
			if (row === "head") {
				// Same as alt+s; the highlight stays on the header so Enter again expands.
				this.toggleCollapsed();
				this.selected = 0;
				return true;
			}
			if (row === "more") this.toggleShowAll();
			else if (row) {
				this.selected = undefined;
				this.onOpen?.(row.taskId);
			}
		} else {
			this.selected = undefined;
			this.tui?.requestRender();
			return false;
		}
		this.tui?.requestRender();
		return true;
	}

	toggleShowAll(): void {
		this.showAll = !this.showAll;
		this.tui?.requestRender(true);
	}

	/** Remembered globally, so the next session opens the way this one was left. */
	toggleCollapsed(): void {
		this.collapsed = !this.collapsed;
		void writeSubagentConfig({ widgetCollapsed: this.collapsed }).catch(() => {});
		// Regular mode keeps the old bottom rows when content shrinks, so the editor floats up; a full
		// redraw re-anchors it. Same path pi takes on resize.
		this.tui?.requestRender(true);
	}

	/** Remove the widget from the UI; pending timers keep running and re-create it on demand. */
	clear(ctx?: ExtensionContext): void {
		this.runs = [];
		this.tui = null;
		this.component = undefined;
		this.selected = undefined;
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
				const clickable = tui.mode === "fullscreen";
				this.component = new SubagentsWidget(() => [...this.runs], theme, {
					collapsed: () => this.collapsed,
					showAll: () => this.showAll,
					selected: () => this.selected,
					toggle: clickable ? () => this.toggleCollapsed() : undefined,
					toggleAll: clickable ? () => this.toggleShowAll() : undefined,
					open: clickable ? (taskId) => this.onOpen?.(taskId) : undefined,
				});
				return this.component;
			},
			{ placement: "aboveEditor" },
		);
	}
}
