import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colorNums, describeCall } from "../src/format.ts";
import { createPeekPane, type PeekTask } from "../src/peek.ts";

const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as any;

test("peek pane: navigate + tail, never mutates tasks", () => {
	const dir = mkdtempSync(join(tmpdir(), "peek-"));
	const file = join(dir, "child.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "do the thing" }] } }),
			JSON.stringify({
				message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] },
			}),
		].join("\n"),
	);
	const tasks: PeekTask[] = [
		{
			runId: "r1",
			taskId: "t1",
			agent: "rev-a",
			status: "running",
			running: true,
			sessionFile: file,
			line: "• rev-a · 3 tools",
		},
		{ runId: "r1", taskId: "t2", agent: "rev-b", status: "running", running: true, line: "• rev-b · 1 tools" },
	];
	const snapshot = JSON.stringify(tasks);
	let closed = false;
	const aborted: string[] = [];
	const pane = createPeekPane(
		() => tasks,
		theme,
		() => {},
		() => (closed = true),
		(t) => aborted.push(t.taskId),
	);

	expect(pane.render(80).join("\n")).toMatch(/❯ • rev-a/);
	pane.handleInput("\x1b[B");
	expect(pane.render(80).join("\n")).toMatch(/❯ • rev-b/);
	pane.handleInput("\x1b[A");
	pane.handleInput("j");
	expect(pane.render(80).join("\n")).toMatch(/❯ • rev-b/);
	pane.handleInput("\x1b[1;2A");
	expect(pane.render(80).join("\n")).toMatch(/❯ • rev-a/);
	pane.handleInput("\r");
	const tail = pane.render(80).join("\n");
	expect(tail).toMatch(/→ read/);
	pane.handleInput("\x1b");
	expect(pane.render(80).join("\n")).toMatch(/❯ • rev-a/);
	expect(closed).toBe(false);
	pane.handleInput("\x1b");
	expect(closed).toBe(true);

	pane.handleInput("x");
	expect(pane.render(80).join("\n")).toMatch(/abort rev-a\?\s+y \/ n/);
	pane.handleInput("n");
	expect(aborted).toEqual([]);
	pane.handleInput("x");
	pane.handleInput("y");
	expect(aborted).toEqual(["t1"]);
	expect(JSON.stringify(tasks)).toBe(snapshot);
	pane.dispose();
});

test("a hard runtime ceiling exists; an explicit maxRuntimeMs always wins", () => {
	const src = require("node:fs").readFileSync(new URL("../src/manager.ts", import.meta.url), "utf8");
	const cap = src.match(/const DEFAULT_RUNTIME_MS = ([\d_]+);/) as RegExpMatchArray | null;
	if (!cap?.[1]) throw new Error("DEFAULT_RUNTIME_MS not found");
	expect(Number(cap[1].replaceAll("_", ""))).toBeGreaterThan(0);
	expect(src).toMatch(/if \(maxRuntimeMs > 0\)/);

	expect(src).toMatch(/input\.maxRuntimeMs \?\? \(this\.autoLimit \? DEFAULT_RUNTIME_MS : UNLIMITED_RUNTIME_MS\)/);
	const ceiling = src.match(/const UNLIMITED_RUNTIME_MS = ([\d_]+);/) as RegExpMatchArray | null;
	if (!ceiling?.[1]) throw new Error("UNLIMITED_RUNTIME_MS not found");
	expect(Number(ceiling[1].replaceAll("_", ""))).toBeGreaterThan(0);
});

test("describeCall renders human activity lines", () => {
	expect(describeCall("read", { path: "src/index.ts" })).toBe("Read src/index.ts");
	expect(describeCall("grep", { pattern: "wrapSingleLine", path: "src/" })).toBe("Grep wrapSingleLine");
	expect(describeCall("read", { path: "/repo/src/a.ts" }, "/repo")).toBe("Read src/a.ts");
	expect(describeCall("bash", { command: "ls  -la\n/tmp" })).toBe("Bash ls -la /tmp");
	expect(describeCall("weird_tool", { count: 3 })).toBe("Weird_tool");
	expect(describeCall("custom", { blob: "x".repeat(80) }).endsWith("…")).toBe(true);
});

test("colorNums never colors inside ANSI escapes", () => {
	const theme = {
		fg: (c: string, s: string) => `\x1b[${c === "syntaxNumber" ? "38;2;1;2;3" : "38;2;9;9;9"}m${s}\x1b[0m`,
	} as any;
	const out = colorNums("16 tools · ↑ 460.6k · running 2m30s", theme);

	expect(out).toContain("38;2;1;2;3m460.6k\x1b[0m");
	expect(out).toContain("38;2;1;2;3m2m30s\x1b[0m");

	expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe("16 tools · ↑ 460.6k · running 2m30s");
});

test("peek rows are full-width so the transcript can't bleed through", () => {
	const t = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as any;
	const tasks: PeekTask[] = [
		{ runId: "r", taskId: "t", agent: "a", status: "running", running: true, line: "• a · 1 tools" },
	];
	const pane = createPeekPane(
		() => tasks,
		t,
		() => {},
		() => {},
		() => {},
	);
	for (const line of pane.render(80)) expect(line.length).toBe(80);
	pane.dispose();
});

test("the pane is a closed box: capped top and bottom, every row edged", () => {
	const tasks: PeekTask[] = [
		{ runId: "r", taskId: "t", agent: "a", status: "running", running: true, line: "• a · 1 tools" },
	];
	const pane = createPeekPane(
		() => tasks,
		theme,
		() => {},
		() => {},
		() => {},
	);
	const rows = pane.render(60);
	expect(rows[0]).toBe(`╭${"─".repeat(58)}╮`);
	expect(rows.at(-1)).toBe(`╰${"─".repeat(58)}╯`);
	expect(rows.some((r) => r === `├${"─".repeat(58)}┤`)).toBe(true);

	for (const r of rows.slice(1, -1)) {
		expect(r.startsWith("│") || r.startsWith("├")).toBe(true);
		expect(r.endsWith("│") || r.endsWith("┤")).toBe(true);
		expect(r.length).toBe(60);
	}
	pane.dispose();
});

test("the empty state is boxed too, not a bare line", () => {
	const pane = createPeekPane(
		() => [],
		theme,
		() => {},
		() => {},
		() => {},
	);
	const rows = pane.render(40);
	expect(rows).toHaveLength(3);
	expect(rows[0]?.startsWith("╭")).toBe(true);
	expect(rows[1]).toContain("No subagents");
	expect(rows.at(-1)?.startsWith("╰")).toBe(true);
	for (const r of rows) expect(r.length).toBe(40);
	pane.dispose();
});

function tailRows(entries: unknown[], width = 120): string[] {
	const dir = mkdtempSync(join(tmpdir(), "peek-tail-"));
	const file = join(dir, "child.jsonl");

	writeFileSync(file, ["", ...entries.map((e) => JSON.stringify(e))].join("\n"));
	const tasks: PeekTask[] = [
		{ runId: "r", taskId: "t", agent: "a", status: "running", running: true, sessionFile: file, line: "• a" },
	];
	const pane = createPeekPane(
		() => tasks,
		theme,
		() => {},
		() => {},
		() => {},
	);
	pane.handleInput("\r");
	const rows = pane.render(width).map((l) => l.trim());
	pane.dispose();
	return rows;
}

test("empty <think></think> turns are dropped, not rendered as blank rows", () => {
	const rows = tailRows([
		{ message: { role: "assistant", content: [{ type: "text", text: "<think></think>" }] } },
		{ message: { role: "assistant", content: [{ type: "text", text: "<think>hidden</think>real answer" }] } },
	]);
	expect(rows.some((r) => r.includes("<think>"))).toBe(false);
	expect(rows.some((r) => r.includes("hidden"))).toBe(false);
	expect(rows.some((r) => r.includes("real answer"))).toBe(true);
});

test("every tool call in a turn is shown, not only the first", () => {
	const rows = tailRows([
		{
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "<think></think>" },
					{ type: "toolCall", name: "read", arguments: { path: "one.ts" } },
					{ type: "toolCall", name: "read", arguments: { path: "two.ts" } },
					{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
				],
			},
		},
	]);
	expect(rows.some((r) => r.includes("one.ts"))).toBe(true);
	expect(rows.some((r) => r.includes("two.ts"))).toBe(true);
	expect(rows.some((r) => r.includes("bash ls"))).toBe(true);
});

test("a call summary picks the identifying arg, never an oldText blob", () => {
	const rows = tailRows([
		{
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "edit", arguments: { oldText: "z".repeat(200), path: "src/app.ts" } }],
			},
		},
	]);
	expect(rows.some((r) => r.includes("edit src/app.ts"))).toBe(true);
	expect(rows.some((r) => r.includes("zzz"))).toBe(false);
});

test("failed tool results are marked, and results name their tool", () => {
	const rows = tailRows([
		{ message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "exit 1" }] } },
		{ message: { role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "ok" }] } },
	]);
	expect(rows.some((r) => r.includes("✗ bash: exit 1"))).toBe(true);
	expect(rows.some((r) => r.includes("← read: ok"))).toBe(true);
});

test("long absolute paths are shortened from the left, keeping the tail", () => {
	const rows = tailRows([
		{
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "read", arguments: { path: "/Users/me/Code/work/proj/app/agents/service.py" } },
				],
			},
		},
	]);
	const row = rows.find((r) => r.includes("service.py"));
	expect(row).toBeDefined();
	expect(row).toContain("…/app/agents/service.py");
	expect(row).not.toContain("/Users/me");
});

test("a tail with nothing renderable says so instead of showing an empty frame", () => {
	const rows = tailRows([{ message: { role: "assistant", content: [{ type: "text", text: "<think></think>" }] } }]);
	expect(rows.some((r) => r.includes("(no activity yet)"))).toBe(true);
});

function tailingPane(count: number) {
	const dir = mkdtempSync(join(tmpdir(), "peek-scroll-"));
	const file = join(dir, "child.jsonl");
	const entry = (n: number) =>
		JSON.stringify({
			message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: `f${n}.ts` } }] },
		});
	writeFileSync(file, ["", ...Array.from({ length: count }, (_, i) => entry(i))].join("\n"));
	const tasks: PeekTask[] = [
		{ runId: "r", taskId: "t", agent: "a", status: "running", running: true, sessionFile: file, line: "• a" },
	];
	const pane = createPeekPane(
		() => tasks,
		theme,
		() => {},
		() => {},
		() => {},
	);
	pane.handleInput("\r");
	const rows = () => pane.render(100).map((l) => l.trim());
	const append = (n: number) => appendFileSync(file, `\n${entry(n)}`);
	return { pane, rows, append };
}

test("a fresh tail is live: newest lines, no scrollback banner", () => {
	const { pane, rows } = tailingPane(40);
	const r = rows();
	expect(r.some((l) => l.includes("f39.ts"))).toBe(true);
	expect(r.some((l) => l.includes("f0.ts"))).toBe(false);
	expect(r.some((l) => l.includes("older"))).toBe(false);
	pane.dispose();
});

test("k scrolls back one row and says how far back you are", () => {
	const { pane, rows } = tailingPane(40);
	pane.handleInput("k");
	const r = rows();
	expect(r.some((l) => l.includes("f39.ts"))).toBe(false);
	expect(r.some((l) => l.includes("f38.ts"))).toBe(true);
	expect(r.some((l) => l.includes("↑ 1 older"))).toBe(true);
	pane.dispose();
});

test("G returns to live, j walks back down toward it", () => {
	const { pane, rows } = tailingPane(40);
	for (let i = 0; i < 5; i++) pane.handleInput("k");
	expect(rows().some((l) => l.includes("↑ 5 older"))).toBe(true);
	pane.handleInput("j");
	expect(rows().some((l) => l.includes("↑ 4 older"))).toBe(true);
	pane.handleInput("G");
	expect(rows().some((l) => l.includes("older"))).toBe(false);
	expect(rows().some((l) => l.includes("f39.ts"))).toBe(true);
	pane.dispose();
});

test("scrolling past either end is a no-op, never a wrap", () => {
	const { pane, rows } = tailingPane(40);
	for (let i = 0; i < 200; i++) pane.handleInput("k");
	const top = rows();
	expect(top.some((l) => l.includes("f0.ts"))).toBe(true);
	expect(top.filter((l) => l.startsWith("│")).length).toBeGreaterThan(3);
	for (let i = 0; i < 200; i++) pane.handleInput("j");
	const live = rows();
	expect(live.some((l) => l.includes("f39.ts"))).toBe(true);
	expect(live.some((l) => l.includes("older"))).toBe(false);
	pane.dispose();
});

test("g jumps to the oldest readable line", () => {
	const { pane, rows } = tailingPane(40);
	pane.handleInput("g");
	expect(rows().some((l) => l.includes("f0.ts"))).toBe(true);
	pane.dispose();
});

test("a scrolled-back view stays on the same lines as the child appends", () => {
	const { pane, rows, append } = tailingPane(40);
	for (let i = 0; i < 5; i++) pane.handleInput("k");
	const before = rows().filter((l) => l.includes(".ts"));
	append(40);
	append(41);
	const after = rows().filter((l) => l.includes(".ts"));
	expect(after).toEqual(before);
	expect(rows().some((l) => l.includes("↑ 7 older"))).toBe(true);
	pane.dispose();
});

test("a live view does follow new output", () => {
	const { pane, rows, append } = tailingPane(40);
	append(40);
	expect(rows().some((l) => l.includes("f40.ts"))).toBe(true);
	pane.dispose();
});

test("leaving the tail resets scrollback, so re-entering starts live", () => {
	const { pane, rows } = tailingPane(40);
	for (let i = 0; i < 5; i++) pane.handleInput("k");
	pane.handleInput("\x1b");
	pane.handleInput("\r");
	expect(rows().some((l) => l.includes("older"))).toBe(false);
	expect(rows().some((l) => l.includes("f39.ts"))).toBe(true);
	pane.dispose();
});

test("in the LIST, j/k still move between agents instead of scrolling", () => {
	const tasks: PeekTask[] = [
		{ runId: "r", taskId: "t1", agent: "a1", status: "running", running: true, line: "• a1" },
		{ runId: "r", taskId: "t2", agent: "a2", status: "running", running: true, line: "• a2" },
	];
	const pane = createPeekPane(
		() => tasks,
		theme,
		() => {},
		() => {},
		() => {},
	);
	expect(pane.render(60).some((l) => l.includes("1/2"))).toBe(true);
	pane.handleInput("j");
	expect(pane.render(60).some((l) => l.includes("2/2"))).toBe(true);
	pane.dispose();
});
