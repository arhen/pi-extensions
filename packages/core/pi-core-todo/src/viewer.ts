import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { TaskTree, type TaskRow } from "./tree.ts";
import type { TaskState } from "./types.ts";
import { clip, taskLine, viewerBudget } from "./view.ts";

export class TodoViewer implements Component {
	private collapsed = new Set<number>();
	private selectedId: number | undefined;
	private offset = 0;
	private tasks: TaskState["tasks"] | undefined;
	private tree = new TaskTree([]);

	constructor(private readonly tui: TUI, private readonly theme: Theme, private readonly getState: () => TaskState, private readonly done: () => void) {}

	private rows(): TaskRow[] {
		const state = this.getState();
		if (state.tasks !== this.tasks) {
			this.tasks = state.tasks;
			this.tree = new TaskTree(state.tasks);
			if (this.selectedId === undefined) this.selectedId = state.tasks.find((task) => task.status === "in_progress")?.id;
		}
		const rows = this.tree.rows(this.collapsed);
		if (!rows.some((row) => row.task.id === this.selectedId)) this.selectedId = rows[0]?.task.id;
		return rows;
	}

	private capacity(): number {
		const budget = viewerBudget(this.tui.terminal.rows);
		return Math.max(1, budget - (budget >= 3 ? 2 : budget === 2 ? 1 : 0));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		const rows = this.rows();
		const index = rows.findIndex((row) => row.task.id === this.selectedId);
		const row = rows[index];
		if (!row) return;
		let nextIndex = index;
		if (matchesKey(data, "up")) nextIndex--;
		else if (matchesKey(data, "down")) nextIndex++;
		else if (matchesKey(data, "pageUp")) nextIndex -= this.capacity();
		else if (matchesKey(data, "pageDown")) nextIndex += this.capacity();
		else if (matchesKey(data, "home")) nextIndex = 0;
		else if (matchesKey(data, "end")) nextIndex = rows.length - 1;
		else if (matchesKey(data, "left")) {
			if (this.tree.progress(row.task.id).total && !this.collapsed.has(row.task.id)) this.collapsed.add(row.task.id);
			else {
				const ancestors = this.tree.ancestors(row.task.id).reverse();
				const parent = ancestors.find((id) => rows.some((row) => row.task.id === id));
				if (parent !== undefined) this.selectedId = parent;
			}
		} else if (matchesKey(data, "right")) {
			if (this.collapsed.has(row.task.id)) this.collapsed.delete(row.task.id);
			else if (rows[index + 1] && rows[index + 1]!.depth > row.depth) this.selectedId = rows[index + 1]!.task.id;
		} else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			if (this.tree.progress(row.task.id).total) {
				if (this.collapsed.has(row.task.id)) this.collapsed.delete(row.task.id);
				else this.collapsed.add(row.task.id);
			}
		} else return;
		if (nextIndex !== index) this.selectedId = rows[Math.max(0, Math.min(rows.length - 1, nextIndex))]!.task.id;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const rows = this.rows();
		const budget = viewerBudget(this.tui.terminal.rows);
		const capacity = this.capacity();
		const selected = rows.findIndex((row) => row.task.id === this.selectedId);
		if (selected < this.offset) this.offset = Math.max(0, selected);
		if (selected >= this.offset + capacity) this.offset = selected - capacity + 1;
		this.offset = Math.max(0, Math.min(this.offset, rows.length - capacity));
		const live = this.tasks?.filter((task) => task.status !== "deleted") ?? [];
		const done = live.filter((task) => task.status === "completed").length;
		const lines: string[] = [];
		if (budget >= 3) lines.push(clip(this.theme.fg("accent", `Todos (${done}/${live.length}) · ${rows.length ? this.offset + 1 : 0}–${Math.min(rows.length, this.offset + capacity)} of ${rows.length}`), width));
		for (const row of rows.slice(this.offset, this.offset + capacity)) {
			const hasChildren = this.tree.progress(row.task.id).total > 0;
			const branch = this.tree.isLastSibling(row.task.id) ? "└─" : "├─";
			const disclosure = hasChildren ? branch + (this.collapsed.has(row.task.id) ? "▸" : "▾") : undefined;
			const text = taskLine(this.tree, row, this.theme, Math.max(0, width - 2), disclosure);
			let line = clip(`${row.task.id === this.selectedId ? "› " : "  "}${text}`, width);
			if (row.task.id === this.selectedId) line = this.theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))));
			lines.push(line);
		}
		if (!rows.length) lines.push(clip(this.theme.fg("muted", "No todos"), width));
		if (budget >= 2) lines.push(clip(this.theme.fg("dim", "↑↓ navigate · ←→ fold · PgUp/PgDn · Esc close"), width));
		return lines.slice(0, budget);
	}

	invalidate(): void {}
}
