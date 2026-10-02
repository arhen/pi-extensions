import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./state.ts";
import { prioritizeRows, TaskTree, type TaskRow } from "./tree.ts";
import type { TaskDetails, TaskState } from "./types.ts";

export function widgetBudget(terminalRows: number): number {
	return Math.max(0, Math.min(8, Math.floor(terminalRows / 4)));
}

export function viewerBudget(terminalRows: number): number {
	return Math.max(1, Math.min(24, Math.floor(terminalRows * 0.7)));
}

export function clip(line: string, width: number): string {
	return width > 0 ? truncateToWidth(line, width, "…") : "";
}

export function taskLine(tree: TaskTree, row: TaskRow, theme: Theme, width: number, disclosure?: string, contextAncestors?: readonly number[]): string {
	const task = row.task;
	const indentLimit = Math.max(0, Math.min(3, Math.floor((width - 28) / 3)));
	const path = contextAncestors ?? tree.ancestors(task.id);
	const indent = Math.min(path.length, indentLimit);
	const ancestors = indent ? path.slice(-indent) : [];
	const trunk = ancestors.map((id) => tree.isLastSibling(id) ? "   " : "│  ").join("");
	const branch = disclosure ?? (tree.isLastSibling(task.id) ? "└─" : "├─");
	const prefix = width < 24 ? "" : theme.fg("dim", `${trunk}${branch} `);
	const color = task.status === "in_progress" ? "warning" : task.status === "completed" ? "success" : "dim";
	const glyph = task.status === "in_progress" ? "◐" : task.status === "completed" ? "✓" : task.status === "deleted" ? "⊘" : "○";
	const { done, total } = tree.progress(task.id);
	const progress = total ? ` [${done}/${total}]` : "";
	const depth = row.depth > indent ? ` [depth ${row.depth + 1}]` : "";
	const suffix = theme.fg("muted", progress + depth);
	const lead = `${prefix}${theme.fg(color, glyph)} `;
	const available = Math.max(0, width - visibleWidth(lead) - visibleWidth(suffix));
	const title = task.subject + (task.status === "in_progress" && task.activeForm ? ` (${task.activeForm})` : "");
	let subject = theme.fg(task.status === "in_progress" ? "accent" : task.status === "completed" ? "muted" : "text", clip(sanitizeTerminalText(title), available));
	if (task.status === "completed" || task.status === "deleted") subject = theme.strikethrough(subject);
	return clip(lead + subject + suffix, width);
}

export interface WidgetRender {
	lines: string[];
	displayedIds: number[];
}

export function renderWidget(state: TaskState, hiddenCompleted: ReadonlySet<number>, theme: Theme, width: number, terminalRows: number): WidgetRender {
	const budget = widgetBudget(terminalRows);
	const live = state.tasks.filter((task) => task.status !== "deleted");
	const visible = new Set(live.filter((task) => !(task.status === "completed" && hiddenCompleted.has(task.id))).map((task) => task.id));
	if (!budget || !visible.size || width <= 0) return { lines: [], displayedIds: [] };
	const tree = new TaskTree(state.tasks);
	const done = live.filter((task) => task.status === "completed").length;
	const active = live.find((task) => task.status === "in_progress");
	const head = `${theme.fg(active ? "accent" : "muted", active ? "●" : "○")} ${theme.fg("muted", `Todos (${done}/${live.length})`)}`;
	if (budget === 1) {
		const row = active && tree.preorder.find((row) => row.task.id === active.id);
		return { lines: [row ? taskLine(tree, row, theme, width, undefined, []) : clip(`${head} · /todos`, width)], displayedIds: row ? [row.task.id] : [] };
	}
	const needsSummary = live.length > budget - 1;
	const rows = prioritizeRows(tree, visible, Math.max(1, budget - 1 - (needsSummary && budget > 2 ? 1 : 0)));
	const lines = [clip(head, width)];
	const displayed = new Set(rows.map((row) => row.task.id));
	for (const row of rows) {
		const ancestors = tree.ancestors(row.task.id).filter((id) => displayed.has(id));
		lines.push(taskLine(tree, row, theme, width, undefined, ancestors));
	}
	const hidden = live.length - rows.length;
	if (hidden > 0 && lines.length < budget) lines.push(clip(theme.fg("dim", `└─ +${hidden} hidden · /todos`), width));
	return { lines, displayedIds: rows.map((row) => row.task.id) };
}

export class BoundedLines implements Component {
	constructor(private readonly lines: () => string[], private readonly limit: () => number, private readonly theme: Theme) {}

	render(width: number): string[] {
		const limit = Math.max(1, this.limit());
		const lines = this.lines();
		if (lines.length <= limit) return lines.map((line) => clip(line, width));
		if (limit === 1) return [clip(lines[0]!, width)];
		return [...lines.slice(0, limit - 1).map((line) => clip(line, width)), clip(this.theme.fg("dim", `+${lines.length - limit + 1} more · /todos`), width)];
	}

	invalidate(): void {}
}

export function resultLines(details: TaskDetails | undefined, fallback: string, theme: Theme, width: number, limit = 8): string[] {
	if (!details || details.error) return fallback.split(/\r?\n/).map((line) => theme.fg(details?.error ? "error" : "muted", sanitizeTerminalText(line)));
	if (details.action === "clear") return [theme.fg("muted", "Cleared todos")];
	const tree = new TaskTree(details.tasks);
	if (details.action === "list") {
		const includeDeleted = Boolean(details.params.includeDeleted);
		const rows = tree.preorder.filter((row) => (includeDeleted || row.task.status !== "deleted") && (!details.params.status || row.task.status === details.params.status));
		if (!rows.length) return [theme.fg("muted", "No tasks")];
		const count = Math.max(1, limit - (rows.length > limit ? 1 : 0));
		const lines = rows.slice(0, count).map((row) => taskLine(tree, row, theme, width));
		if (rows.length > count && lines.length < limit) lines.push(theme.fg("dim", `+${rows.length - count} hidden · /todos`));
		return lines;
	}
	const id = details.action === "create" ? details.nextId - 1 : details.params.id;
	const row = tree.preorder.find((row) => row.task.id === id);
	if (!row) return [theme.fg("muted", sanitizeTerminalText(fallback))];
	const lines = [taskLine(tree, row, theme, width)];
	if (details.action === "get") {
		const parent = tree.parent.get(row.task.id);
		lines.push(theme.fg("muted", `parent: ${parent === undefined ? "root" : sanitizeTerminalText(tree.byId.get(parent)?.subject ?? "unknown")}`));
		if (row.task.description) lines.push(theme.fg("muted", sanitizeTerminalText(row.task.description)));
		if (row.task.activeForm) lines.push(theme.fg("muted", sanitizeTerminalText(row.task.activeForm)));
		if (row.task.owner) lines.push(theme.fg("muted", `owner: ${sanitizeTerminalText(row.task.owner)}`));
	}
	if (row.task.blockedBy?.length) lines.push(theme.fg("muted", `blocked by: ${row.task.blockedBy.map((id) => sanitizeTerminalText(tree.byId.get(id)?.subject ?? "unknown task")).join(", ")}`));
	return lines;
}

export class TodoResultPreview implements Component {
	constructor(private readonly details: TaskDetails | undefined, private readonly fallback: string, private readonly theme: Theme, private readonly terminalRows: () => number, private readonly expanded: boolean) {}

	render(width: number): string[] {
		const limit = Math.max(1, Math.min(this.expanded ? 8 : 5, widgetBudget(this.terminalRows())));
		const lines = resultLines(this.details, this.fallback, this.theme, width, limit);
		return new BoundedLines(() => lines, () => limit, this.theme).render(width);
	}

	invalidate(): void {}
}
