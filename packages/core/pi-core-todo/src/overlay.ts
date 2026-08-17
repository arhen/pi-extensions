/**
 * Todo tree widget — register-once + requestRender, same pattern as
 * pi-subagent's widget. Heading `● Todos (n/m)`, rows `├─/└─` with status
 * glyphs, `#id` + `⛓ deps` when dependencies exist, completed rows hide one
 * turn after completion. No config, no i18n, no collapse.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { getRenderState } from "./store.ts";
import { sanitizeTerminalText } from "./state.ts";
import type { Task, TaskState } from "./types.ts";
import { WIDGET_KEY } from "./types.ts";

const MAX_ROWS = 12;
const OVERLAY_HEADING = "Todos";

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;

	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const state = getRenderState();
		const visible = this.visibleTasks(state);
		if (visible.length === 0) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}
		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
						invalidate: () => {
							/* no cached strings; render reads live state */
						},
					} as Component;
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
	}

	/** Called on agent_start: rows completed in the previous turn drop out. */
	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.tui?.requestRender();
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.resetCompletedDisplayState();
	}

	// ── internals ────────────────────────────────────────────────────────

	private visibleTasks(state: TaskState): Task[] {
		return state.tasks.filter((t) => t.status !== "deleted" && !(t.status === "completed" && this.hiddenCompletedTaskIds.has(t.id)));
	}

	private trackSnapshot(state: TaskState): void {
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;
		const completed = new Set(state.tasks.filter((t) => t.status === "completed").map((t) => t.id));
		for (const id of this.completedTaskIdsPendingHide) {
			if (!completed.has(id)) this.completedTaskIdsPendingHide.delete(id);
		}
		for (const id of this.hiddenCompletedTaskIds) {
			if (!completed.has(id)) this.hiddenCompletedTaskIds.delete(id);
		}
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const state = getRenderState();
		this.trackSnapshot(state);
		const visible = this.visibleTasks(state);
		if (visible.length === 0) return [];

		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const hasActive = visible.some((t) => t.status === "pending" || t.status === "in_progress");
		const completed = visible.filter((t) => t.status === "completed").length;
		const showIds = visible.some((t) => t.blockedBy && t.blockedBy.length > 0);

		const head = hasActive ? "accent" : "dim";
		const lines: string[] = [
			truncate(`${theme.fg(head, hasActive ? "●" : "○")} ${theme.fg(head, `${OVERLAY_HEADING} (${completed}/${visible.length})`)}`),
		];

		// Budget: drop completed first, then truncate the tail with a summary row.
		let rows: Task[];
		let hiddenCompleted = 0;
		let truncatedTail = 0;
		if (visible.length <= MAX_ROWS) {
			rows = visible;
		} else {
			const budget = MAX_ROWS - 1;
			const nonCompleted = visible.filter((t) => t.status !== "completed");
			const totalCompleted = visible.length - nonCompleted.length;
			if (nonCompleted.length <= budget) {
				// L5: completed-first drop — pending rows must not be displaced by early completed ones.
				rows = [...nonCompleted, ...visible.filter((t) => t.status === "completed")].slice(0, budget);
				// rows is reordered (non-completed first) — hidden counts come from the rows
				// complement, not from slicing the original order.
				hiddenCompleted = totalCompleted - (rows.length - nonCompleted.length);
				truncatedTail = 0; // every non-completed task fits within the budget
			} else {
				rows = nonCompleted.slice(0, budget);
				truncatedTail = nonCompleted.length - budget;
				hiddenCompleted = totalCompleted;
			}
		}

		rows.forEach((task, i) => {
			const last = i === rows.length - 1 && hiddenCompleted === 0 && truncatedTail === 0;
			lines.push(truncate(`${theme.fg("dim", last ? "└─" : "├─")} ${this.taskLine(task, theme, showIds)}`));
		});

		// Newly displayed completed rows are hidden as of the next turn.
		for (const task of rows) {
			if (task.status === "completed" && !this.completedTaskIdsPendingHide.has(task.id) && !this.hiddenCompletedTaskIds.has(task.id)) {
				this.completedTaskIdsPendingHide.add(task.id);
			}
		}

		const totalHidden = hiddenCompleted + truncatedTail;
		if (totalHidden > 0) {
			const parts: string[] = [];
			if (hiddenCompleted > 0) parts.push(`${hiddenCompleted} completed`);
			if (truncatedTail > 0) parts.push(`${truncatedTail} pending`);
			lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${totalHidden} more (${parts.join(", ")})`)}`));
		}

		lines.push(""); // breathing room above the editor box
		return lines;
	}

	private taskLine(t: Task, theme: Theme, showId: boolean): string {
		const glyph =
			t.status === "in_progress" ? theme.fg("warning", "◐") : t.status === "completed" ? theme.fg("success", "✓") : theme.fg("dim", "○");
		const subjectColor = t.status === "in_progress" ? "accent" : t.status === "completed" ? "muted" : "text";
		let subject = theme.fg(subjectColor, sanitizeTerminalText(t.subject));
		if (t.status === "completed") subject = theme.strikethrough(subject);
		let line = glyph;
		if (showId) line += ` ${theme.fg("dim", `#${t.id}`)}`;
		line += ` ${subject}`;
		if (t.status === "in_progress" && t.activeForm) line += ` ${theme.fg("muted", `(${sanitizeTerminalText(t.activeForm)})`)}`;
		if (t.blockedBy?.length) line += ` ${theme.fg("muted", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
		return line;
	}
}
