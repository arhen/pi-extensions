import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { SubagentsWidget } from "../src/format.ts";
import type { PeekTask } from "../src/peek.ts";
import { createSessionView } from "../src/session-view.ts";
import type { RunSnapshot, TaskRef, TaskSnapshot } from "../src/types.ts";

initTheme();
const keybindings = new KeybindingsManager({
	...TUI_KEYBINDINGS,
	"app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Toggle thinking blocks" },
});
setKeybindings(keybindings);
const plain = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	getThinkingBorderColor: () => (s: string) => s,
} as any;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const task = (id: string, status: TaskSnapshot["status"] = "running"): TaskSnapshot =>
	({
		id,
		runId: "r",
		agent: id,
		task: "t",
		cwd: "/",
		status,
		toolCalls: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	}) as TaskSnapshot;
const run = (tasks: TaskSnapshot[]) => [{ id: "r", status: "running", tasks } as unknown as RunSnapshot];
const click = (y: number) => ({ type: "click", button: "left", y }) as any;

test("widget rows are click targets: header collapses, task opens, +N more shows all", () => {
	const tasks = ["a", "b", "c", "d", "e", "f"].map((id) => task(id));
	const calls: string[] = [];
	let showAll = false;
	const widget = new SubagentsWidget(() => run(tasks), plain, {
		collapsed: () => false,
		showAll: () => showAll,
		toggle: () => calls.push("toggle"),
		toggleAll: () => (showAll = !showAll),
		open: (t) => calls.push(`open:${t.taskId}`),
	});

	const lines = widget.render(200);
	expect(lines.at(-1)).toContain("+2 more · click to show");
	widget.handleMouse(click(0));
	widget.handleMouse(click(2));
	expect(calls).toEqual(["toggle", "open:b"]);

	widget.handleMouse(click(lines.length - 1));
	const all = widget.render(200);
	expect(all.join("\n")).toContain("f");
	expect(all.at(-1)).toContain("show less");
	widget.handleMouse(click(all.length - 1));
	expect(widget.render(200).at(-1)).toContain("+2 more");
});

test("widget rows carry their run, so colliding task ids open the right task", () => {
	const opened: string[] = [];
	const owned = (runId: string, agent: string) => ({ ...task("task_1"), runId, agent });
	const widget = new SubagentsWidget(
		() => [
			{ id: "run-a", status: "running", tasks: [owned("run-a", "alpha")] } as unknown as RunSnapshot,
			{ id: "run-b", status: "running", tasks: [owned("run-b", "beta")] } as unknown as RunSnapshot,
		],
		plain,
		{ collapsed: () => false, toggle: () => {}, open: (t) => opened.push(`${t.runId}/${t.taskId}`) },
	);

	widget.render(200);
	widget.handleMouse(click(1));
	widget.handleMouse(click(2));
	expect(opened).toEqual(["run-a/task_1", "run-b/task_1"]);
});

test("empty leader editor: ↓ enters the widget rows, enter opens, esc leaves", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "subagent-agentdir-"));
	dirs.push(agentDir);
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const { RunWidget } = require("../src/run-widget.ts");
	const widget = new RunWidget();
	const opened: string[] = [];
	widget.onOpen = (t: TaskRef) => opened.push(t.taskId);
	widget.collapsed = false;
	const tasks = ["a", "b", "c", "d", "e"].map((id) => task(id));
	widget.runs = run(tasks);
	const component = new SubagentsWidget(() => widget.runs, plain, {
		collapsed: () => widget.collapsed,
		showAll: () => widget.showAll,
		selected: () => widget.selected,
	});
	(widget as any).component = component;
	const editor = { onExtensionShortcut: () => false };
	let focused: object = editor;
	(widget as any).tui = { hasOverlay: () => false, getFocusedComponent: () => focused, requestRender: () => {} };
	const down = "\x1b[B";
	const up = "\x1b[A";
	component.render(200);

	expect(widget.handleKey(down, false)).toBe(false);
	expect(widget.handleKey(down, true)).toBe(true);
	expect(component.selectable().at(widget.selected)).toEqual({ runId: "r", taskId: "a" });
	expect(component.render(200)[0]).toContain("enter open");

	// ↑ reaches the header; Enter collapses like alt+s, Enter again expands.
	widget.handleKey(up, true);
	expect(component.selectable().at(widget.selected)).toBe("head");
	expect(component.render(200)[0]).toContain("enter collapse");
	widget.handleKey("\r", true);
	expect(widget.collapsed).toBe(true);
	const folded = component.render(200);
	expect(folded).toHaveLength(1);
	expect(folded[0]).toContain("enter expand");
	widget.handleKey("\r", true);
	expect(widget.collapsed).toBe(false);
	expect(component.render(200).length).toBeGreaterThan(1);

	widget.handleKey(down, true);
	widget.handleKey(down, true);
	widget.handleKey("\r", true);
	expect(opened).toEqual(["b"]);
	expect(widget.selected).toBeUndefined();

	widget.handleKey(down, true);
	for (let i = 0; i < 9; i++) widget.handleKey(down, true);
	expect(component.selectable().at(widget.selected)).toBe("more");
	widget.handleKey("\r", true);
	expect(widget.showAll).toBe(true);
	component.render(200);
	// header + 5 tasks + "show less"
	expect(component.selectable()).toHaveLength(7);

	widget.handleKey(up, true);
	const at = widget.selected;
	// Kitty sends press then release; one key press must move one row.
	expect(widget.handleKey("\x1b[1;1:3A", true)).toBe(true);
	expect(widget.selected).toBe(at);
	expect(widget.handleKey("\x1b", true)).toBe(true);
	expect(widget.selected).toBeUndefined();
	expect(widget.handleKey("x", true)).toBe(false);

	// An inline question (ask_user_question) replaces the editor: its options own the arrows.
	widget.handleKey(down, true);
	expect(widget.selected).toBeDefined();
	focused = { handleInput: () => {} };
	expect(widget.handleKey(down, true)).toBe(false);
	expect(widget.handleKey(up, true)).toBe(false);
	expect(widget.selected).toBeUndefined();
	focused = editor;
	expect(widget.handleKey(down, true)).toBe(true);
	await require("../src/config.ts").writeSubagentConfig({});
	if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousDir;
});

test("session view renders the child transcript with a leader bar, follows live, never closes on its own", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-view-"));
	dirs.push(dir);
	const file = join(dir, "child.jsonl");
	const entry = (id: string, message: object) =>
		JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message });
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir }),
			entry("1", { role: "user", content: "say hi", timestamp: 1 }),
			entry("2", {
				role: "assistant",
				provider: "prov",
				model: "mod-1",
				usage: { input: 1200, output: 300, cacheRead: 800, cacheWrite: 0, cost: { total: 0.004 } },
				content: [
					{ type: "thinking", thinking: "pondering the void" },
					{ type: "text", text: "hello from child" },
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo ok" } },
				],
				stopReason: "toolUse",
				timestamp: 2,
			}),
			entry("3", {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 3,
			}),
		].join("\n"),
	);
	const tasks: PeekTask[] = [
		{ runId: "r", taskId: "a", agent: "alpha", status: "running", running: true, sessionFile: file, line: "" },
		{ runId: "r", taskId: "b", agent: "beta", status: "queued", running: true, line: "" },
		// Same id as alpha but a different run: the flat lookup used to land here.
		{ runId: "other", taskId: "a", agent: "decoy", status: "completed", running: false, line: "" },
	];
	let busy = true;
	let closed = false;
	const sent: string[] = [];
	const tui = { terminal: { rows: 30, columns: 80 }, requestRender: () => {} } as any;
	const view = createSessionView({
		tui,
		theme: plain,
		keybindings: keybindings as any,
		contextWindow: (p, m) => (p === "prov" && m === "mod-1" ? 100_000 : undefined),
		getTasks: () => tasks,
		startTask: { runId: "r", taskId: "a" },
		leaderBusy: () => busy,
		hideThinking: false,
		send: (t, message) => {
			sent.push(`${t.taskId}:${message}`);
			return "sent";
		},
		close: () => (closed = true),
	});

	const screen = () => view.render(80).map(strip).join("\n");
	expect(view.render(80)).toHaveLength(30);
	expect(screen()).toContain("◀ Leader ● working");
	expect(screen()).toContain("subagent: alpha");
	// Run identity decides the row, not the shared `a` id.
	expect(screen()).not.toContain("decoy");
	expect(screen()).toContain("say hi");
	expect(screen()).toContain("hello from child");
	expect(screen()).toContain("echo ok");
	expect(screen()).toContain("prov ▪ mod-1");
	expect(screen()).toContain("↑1.2k");
	expect(screen()).toMatch(/\[░+\] 2\.0% ▪ 2\.0k\/100k/);
	expect(screen()).toContain("alpha is working…");

	// ctrl+t is the leader's thinking toggle and must reach this view too.
	expect(screen()).toContain("pondering the void");
	view.handleInput("\x14");
	const folded = view.render(80).map(strip);
	expect(folded.join("\n")).toContain("Thinking...");
	expect(folded.join("\n")).not.toContain("pondering the void");
	// A click on the collapsed label expands that block back.
	const labelRow = folded.findIndex((line) => line.includes("Thinking..."));
	expect(view.handleMouse({ type: "click", button: "left", y: labelRow, width: 80 } as any)).toEqual({
		handled: true,
	});
	expect(screen()).toContain("pondering the void");

	appendFileSync(
		file,
		`\n${entry("4", { role: "assistant", content: [{ type: "text", text: "second reply" }], stopReason: "stop", timestamp: 4 })}`,
	);
	expect(screen()).toContain("second reply");

	busy = false;
	expect(screen()).toContain("○ idle");
	for (const ch of "hey") view.handleInput(ch);
	view.handleInput("\x1b[13;2u");
	for (const ch of "qh") view.handleInput(ch);
	expect(screen()).toContain("hey");
	expect(screen()).toContain("qh");
	view.handleInput("\r");
	expect(sent).toEqual(["a:hey\nqh"]);
	expect(screen()).toContain("alpha: sent");
	expect(closed).toBe(false);

	view.handleInput("\t");
	expect(screen()).toContain("subagent: beta");
	expect(screen()).toContain("has not started");
	expect(closed).toBe(false);
	view.handleInput("\x1b");
	expect(closed).toBe(true);
	view.dispose();
});
