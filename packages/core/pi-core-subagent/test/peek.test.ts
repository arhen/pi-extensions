import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
	pane.handleInput("\x1b[B"); // down
	expect(pane.render(80).join("\n")).toMatch(/❯ • rev-b/);
	pane.handleInput("\x1b[A"); // up
	pane.handleInput("j"); // vim down
	expect(pane.render(80).join("\n")).toMatch(/❯ • rev-b/);
	pane.handleInput("\x1b[1;2A"); // shift+up
	expect(pane.render(80).join("\n")).toMatch(/❯ • rev-a/);
	pane.handleInput("\r"); // enter → tail
	const tail = pane.render(80).join("\n");
	expect(tail).toMatch(/→ read/);
	pane.handleInput("\x1b"); // esc → back to list
	expect(pane.render(80).join("\n")).toMatch(/❯ • rev-a/);
	expect(closed).toBe(false);
	pane.handleInput("\x1b"); // esc → close
	expect(closed).toBe(true);

	// abort needs confirmation: x then n does nothing, x then y fires once
	pane.handleInput("x");
	expect(pane.render(80).join("\n")).toMatch(/abort rev-a\?\s+y \/ n/);
	pane.handleInput("n");
	expect(aborted).toEqual([]);
	pane.handleInput("x");
	pane.handleInput("y");
	expect(aborted).toEqual(["t1"]);
	expect(JSON.stringify(tasks)).toBe(snapshot); // peek must not mutate run state
	pane.dispose();
});

test("no default runtime cap; explicit maxRuntimeMs still honored", () => {
	// DEFAULT_RUNTIME_MS = 0 means "no timer armed"; any positive value arms one.
	const src = require("node:fs").readFileSync(new URL("../src/manager.ts", import.meta.url), "utf8");
	expect(src).toMatch(/const DEFAULT_RUNTIME_MS = 0;/);
	expect(src).toMatch(/if \(maxRuntimeMs > 0\)/);
});

test("describeCall renders human activity lines", () => {
	expect(describeCall("read", { path: "src/index.ts" })).toBe("Read src/index.ts");
	expect(describeCall("grep", { pattern: "wrapSingleLine", path: "src/" })).toBe("Grep wrapSingleLine");
	expect(describeCall("read", { path: "/repo/src/a.ts" }, "/repo")).toBe("Read src/a.ts");
	expect(describeCall("bash", { command: "ls  -la\n/tmp" })).toBe("Bash ls -la /tmp");
	expect(describeCall("weird_tool", { count: 3 })).toBe("Weird_tool"); // no string arg → verb only
	expect(describeCall("custom", { blob: "x".repeat(80) }).endsWith("…")).toBe(true);
});

test("colorNums never colors inside ANSI escapes", () => {
	const theme = {
		fg: (c: string, s: string) => `\x1b[${c === "syntaxNumber" ? "38;2;1;2;3" : "38;2;9;9;9"}m${s}\x1b[0m`,
	} as any;
	const out = colorNums("16 tools · ↑ 460.6k · running 2m30s", theme);
	// Value + unit is one token: "460.6k" and "2m30s" must not be split mid-number.
	expect(out).toContain("38;2;1;2;3m460.6k\x1b[0m");
	expect(out).toContain("38;2;1;2;3m2m30s\x1b[0m");
	// Strip escapes: the visible text must be unchanged.
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
