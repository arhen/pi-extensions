import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatContent } from "../src/state.ts";
import { childLetter, prioritizeRows, TaskTree } from "../src/tree.ts";
import type { Task, TaskDetails, TaskState } from "../src/types.ts";
import { renderWidget, resultLines, taskLine, TodoResultPreview, viewerBudget, widgetBudget } from "../src/view.ts";
import { TodoViewer } from "../src/viewer.ts";

const theme = {
	fg: (_color: string, text: string) => `\u001b[37m${text}\u001b[39m`,
	bg: (_color: string, text: string) => `\u001b[48;2;48;48;48m${text}\u001b[49m`,
	strikethrough: (text: string) => `\u001b[9m${text}\u001b[29m`,
} as unknown as Theme;
const plain = (lines: string[]) => lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
const task = (id: number, parentId?: number, status: Task["status"] = "pending"): Task => ({ id, subject: `Task ${id}`, status, ...(parentId === undefined ? {} : { parentId }) });
const stateOf = (tasks: Task[]): TaskState => ({ tasks, nextId: Math.max(0, ...tasks.map((task) => task.id)) + 1 });
const fixture = stateOf([task(7), task(8, 7, "completed"), task(9, 7), task(10, 9, "completed"), task(11, 9, "in_progress")]);
const depths = Array.from({ length: 2000 }, (_, index) => task(index + 1, index ? index : undefined, index === 1999 ? "in_progress" : "pending"));

function checkBounds(lines: string[], width: number, height: number) {
	expect(lines.length).toBeLessThanOrEqual(height);
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

function viewer(state: TaskState, rows = 32) {
	const terminal = { rows };
	let redraws = 0;
	let closed = false;
	const tui = { terminal, requestRender: () => { redraws++; } } as unknown as TUI;
	const component = new TodoViewer(tui, theme, () => state, () => { closed = true; });
	return { component, terminal, redraws: () => redraws, closed: () => closed };
}

describe("hierarchical display labels", () => {
	test("roots and every child level use # paths", () => {
		const tree = new TaskTree(fixture.tasks);
		expect(fixture.tasks.map((task) => tree.label(task.id))).toEqual(["#7", "#7.a", "#7.b", "#7.b.a", "#7.b.b"]);
		expect(tree.label(999)).toBe("#999");
	});
	test("letters extend beyond z", () => {
		expect([0, 25, 26, 27, 51, 52, 701, 702].map(childLetter)).toEqual(["a", "z", "aa", "ab", "az", "ba", "zz", "aaa"]);
	});
	test("tombstones reserve sibling letters", () => {
		const tree = new TaskTree([task(1), task(2, 1, "deleted"), task(3, 1), task(4, 1)]);
		expect(tree.label(3)).toBe("#1.b");
		expect(tree.label(4)).toBe("#1.c");
		expect(tree.progress(1)).toEqual({ done: 0, total: 2 });
	});
	test("progress counts direct children, not grandchildren", () => {
		const tree = new TaskTree(fixture.tasks);
		expect(tree.progress(7)).toEqual({ done: 1, total: 2 });
		expect(tree.progress(9)).toEqual({ done: 1, total: 2 });
		expect(tree.progress(11)).toEqual({ done: 0, total: 0 });
		const text = plain(renderWidget(fixture, new Set(), theme, 100, 40).lines);
		expect(text).toContain("Task 7 [1/2]");
		expect(text).not.toContain("#7");
	});
	test("deep labels compress without changing stored hierarchy", () => {
		const tree = new TaskTree(depths);
		expect(tree.preorder.length).toBe(2000);
		expect(tree.label(2000).split(".").length).toBe(2000);
		expect(tree.label(2000, 3)).toBe("#1.….a.a.a");
		expect(tree.ancestors(2000).length).toBe(1999);
	});
	test("restored malformed cycles and missing parents render safely", () => {
		const tree = new TaskTree([task(1, 2), task(2, 1), task(3, 999), task(4, 4)]);
		expect(tree.preorder.length).toBe(4);
		for (const task of tree.tasks) expect(tree.label(task.id).length).toBeLessThan(16);
	});
	test("model output gives paths and stable numeric child references", () => {
		const listed = formatContent({ kind: "list", includeDeleted: false }, fixture);
		expect(listed).toContain("#7.b.b (id: 11)");
		expect(listed).toContain("Task 7 [1/2]");
		const got = formatContent({ kind: "get", task: fixture.tasks[4]! }, fixture);
		expect(got).toContain("parent: #7.b (id: 9)");
	});
});

describe("compact widget", () => {
	test("flat snapshots keep clean title rows", () => {
		const text = plain(renderWidget(stateOf([task(1), task(2), task(3)]), new Set(), theme, 80, 32).lines);
		expect(text).toContain("○ Task 1");
		expect(text).toContain("○ Task 2");
		expect(text).not.toContain("#");
		expect(text).not.toContain("[0/");
	});
	test("late active task is retained ahead of early pending tasks", () => {
		const tasks = Array.from({ length: 1000 }, (_, i) => task(i + 1, undefined, i === 999 ? "in_progress" : "pending"));
		const result = renderWidget(stateOf(tasks), new Set(), theme, 80, 32);
		expect(result.displayedIds).toContain(1000);
		expect(plain(result.lines)).toContain("+994 hidden");
	});
	test("very deep active branch retains root and leaf", () => {
		const result = renderWidget(stateOf(depths), new Set(), theme, 100, 32);
		expect(result.displayedIds).toContain(1);
		expect(result.displayedIds).toContain(2000);
		expect(plain(result.lines)).toContain("[depth 2000]");
	});
	test("completed hiding does not change direct-child totals", () => {
		const result = renderWidget(fixture, new Set([8, 10]), theme, 100, 32);
		expect(plain(result.lines)).toContain("Task 7 [1/2]");
		expect(result.displayedIds).not.toContain(8);
		expect(plain(result.lines)).toContain("+2 hidden");
	});
	test("empty and previously completed-only widgets disappear", () => {
		expect(renderWidget(stateOf([]), new Set(), theme, 80, 32).lines).toEqual([]);
		expect(renderWidget(stateOf([task(1, undefined, "completed")]), new Set([1]), theme, 80, 32).lines).toEqual([]);
	});
	test("prioritization returns at most its row budget", () => {
		const tree = new TaskTree(depths);
		const visible = new Set(depths.map((task) => task.id));
		for (let limit = 0; limit < 8; limit++) expect(prioritizeRows(tree, visible, limit).length).toBeLessThanOrEqual(limit);
	});
	for (const height of [1, 3, 4, 8, 12, 24, 32, 60]) {
		for (const width of [0, 1, 8, 20, 40, 80]) {
			test(`height ${height}, width ${width}: flat and deep stay bounded`, () => {
				for (const state of [fixture, stateOf(depths)]) checkBounds(renderWidget(state, new Set(), theme, width, height).lines, width, widgetBudget(height));
			});
		}
	}
});

describe("tool previews", () => {
	test("nested child numeric IDs are not shown in UI", () => {
		const details: TaskDetails = { action: "get", params: { id: 11 }, tasks: fixture.tasks, nextId: 12 };
		const text = plain(resultLines(details, "", theme, 100));
		expect(text).toContain("Task 11");
		expect(text).toContain("parent: Task 9");
		expect(text).not.toContain("#");
		expect(text).not.toContain("id: 11");
	});
	test("list status and tombstone filters are honored", () => {
		const details: TaskDetails = { action: "list", params: { status: "completed" }, tasks: [...fixture.tasks, task(12, undefined, "deleted")], nextId: 13 };
		expect(plain(resultLines(details, "", theme, 100))).not.toContain("Task 11");
		details.params = { includeDeleted: true, status: "deleted" };
		expect(plain(resultLines(details, "", theme, 100))).toContain("Task 12");
	});
	test("large list preview renders only the finite visible slice", () => {
		const details: TaskDetails = { action: "list", params: {}, tasks: depths, nextId: 2001 };
		const lines = resultLines(details, "", theme, 80, 5);
		expect(lines.length).toBe(5);
		expect(plain(lines)).toContain("+1996 hidden");
	});
	test("ANSI, bidi, newlines and wide characters cannot escape bounds", () => {
		const hostile = { ...task(1), subject: "中文🌳\n\u001b[2J\u202e".repeat(200) };
		const tree = new TaskTree([hostile]);
		const line = taskLine(tree, tree.preorder[0]!, theme, 30);
		expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		expect(line).not.toContain("\n");
		expect(line).not.toContain("\u001b[2J");
		expect(line).not.toContain("\u202e");
	});
	for (const action of ["create", "update", "list", "get", "delete", "clear"] as const) {
		for (const expanded of [false, true]) {
			test(`${action}, expanded=${expanded}: all result branches bounded`, () => {
				const tasks = [...fixture.tasks, { ...task(12), description: "huge ".repeat(3000), activeForm: "working ".repeat(3000), owner: "owner ".repeat(3000) }];
				const details: TaskDetails = { action, params: { id: 12 }, tasks, nextId: 13 };
				for (const data of [details, { ...details, error: "failure" }, undefined]) {
					const component = new TodoResultPreview(data, "long 中文🌳 ".repeat(200) + "\n".repeat(100), theme, () => 12, expanded);
					checkBounds(component.render(20), 20, 3);
				}
			});
		}
	}
});

describe("full tree browser", () => {
	test("collapse and expand preserve selection and direct counts", () => {
		const { component } = viewer(fixture);
		component.render(100);
		component.handleInput("\u001b[H");
		component.handleInput("\u001b[D");
		let text = plain(component.render(100));
		expect(text).toContain("Task 7 [1/2]");
		expect(text).not.toContain("Task 11");
		component.handleInput("\u001b[C");
		text = plain(component.render(100));
		expect(text).toContain("Task 11");
	});
	test("scroll, page, and resize retain selected task", () => {
		const { component, terminal } = viewer(stateOf(Array.from({ length: 100 }, (_, i) => task(i + 1))), 32);
		component.render(80);
		component.handleInput("\u001b[F");
		expect(plain(component.render(80))).toContain("› └─ ○ Task 100");
		terminal.rows = 8;
		checkBounds(component.render(20), 20, viewerBudget(8));
		expect(plain(component.render(80))).toContain("Task 100");
		component.handleInput("\u001b[5~");
		expect(plain(component.render(80))).toContain("Task 97");
	});
	test("Escape and Ctrl+C close via completion callback", () => {
		for (const key of ["\u001b", "\u0003"]) {
			const result = viewer(fixture);
			result.component.handleInput(key);
			expect(result.closed()).toBe(true);
		}
	});
	test("deep active node selected and shown on open", () => {
		const result = viewer(stateOf(depths));
		expect(plain(result.component.render(100))).toContain("[depth 2000]");
	});
	test("live mutation updates counters without closing browser", () => {
		const state = stateOf([task(1), task(2, 1)]);
		const result = viewer(state);
		expect(plain(result.component.render(80))).toContain("[0/1]");
		state.tasks = [task(1), task(2, 1, "completed")];
		expect(plain(result.component.render(80))).toContain("[1/1]");
	});
	for (const height of [1, 3, 4, 8, 12, 24, 32, 60]) {
		for (const width of [1, 8, 20, 40, 80]) {
			test(`height ${height}, width ${width}: full viewer stays bounded`, () => {
				const result = viewer(stateOf(depths), height);
				checkBounds(result.component.render(width), width, viewerBudget(height));
			});
		}
	}
});
