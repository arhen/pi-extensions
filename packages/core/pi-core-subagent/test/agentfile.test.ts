/** Agent-file resolution: lookup order, priority, frontmatter parsing. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentFile } from "../src/agentfile.ts";

let root: string;
let home: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "agentfile-"));
	home = mkdtempSync(join(tmpdir(), "agentfile-home-"));
});
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
}

describe("resolveAgentFile", () => {
	test("finds a file in the project .claude/agents dir", () => {
		write(
			".claude/agents/frndos-architect.md",
			"---\nname: frndos-architect\nmodel: claude-opus-4-6\n---\nYou are the architect.",
		);
		const hit = resolveAgentFile("frndos-architect", root, join(home, ".pi/agent"));
		expect(hit?.body).toBe("You are the architect.");
		expect(hit?.model).toBe("claude-opus-4-6");
	});

	test("parses comma-separated tools frontmatter", () => {
		write(".claude/agents/reader.md", "---\ntools: read, grep, find\n---\nRead stuff.");
		expect(resolveAgentFile("reader", root, join(home, ".pi/agent"))?.tools).toEqual(["read", "grep", "find"]);
	});

	test("file without frontmatter: whole file is the body", () => {
		write(".agents/agents/plain.md", "Just a prompt, no frontmatter.");
		const hit = resolveAgentFile("plain", root, join(home, ".pi/agent"));
		expect(hit?.body).toBe("Just a prompt, no frontmatter.");
		expect(hit?.model).toBeUndefined();
	});

	test(".agents/agents beats .claude/agents in the same dir (single source)", () => {
		write(".agents/agents/twin.md", "---\nmodel: from-agents\n---\nAgents copy.");
		write(".claude/agents/twin.md", "---\nmodel: from-claude\n---\nClaude copy.");
		const hit = resolveAgentFile("twin", root, join(home, ".pi/agent"));
		expect(hit?.model).toBe("from-agents");
		expect(hit?.body).toBe("Agents copy.");
	});

	test("nearest ancestor wins over a farther one", () => {
		write("packages/core/.claude/agents/deep.md", "---\nmodel: near\n---\nNear.");
		write(".claude/agents/deep.md", "---\nmodel: far\n---\nFar.");
		const hit = resolveAgentFile("deep", join(root, "packages/core/sub"), join(home, ".pi/agent"));
		expect(hit?.model).toBe("near");
	});

	test("home fallback: ~/.agents/agents before ~/.claude/agents before ~/.pi/agents", () => {
		for (const sub of [".agents/agents", ".claude/agents", ".pi/agents"])
			mkdirSync(join(home, sub), { recursive: true });
		writeFileSync(join(home, ".agents/agents/global.md"), "---\nmodel: g-agents\n---\nG.");
		writeFileSync(join(home, ".claude/agents/global.md"), "---\nmodel: g-claude\n---\nG.");
		writeFileSync(join(home, ".pi/agents/global.md"), "---\nmodel: g-pi\n---\nG.");
		const hit = resolveAgentFile("global", root, join(home, ".pi/agent"));
		expect(hit?.model).toBe("g-agents");
	});

	test("project beats home", () => {
		write(".claude/agents/global.md", "---\nmodel: project\n---\nP.");
		const hit = resolveAgentFile("global", root, join(home, ".pi/agent"));
		expect(hit?.model).toBe("project");
	});

	test("no match → undefined", () => {
		expect(resolveAgentFile("nobody", root, join(home, ".pi/agent"))).toBeUndefined();
	});

	test("unsafe names are rejected", () => {
		expect(resolveAgentFile("../etc/passwd", root, join(home, ".pi/agent"))).toBeUndefined();
		expect(resolveAgentFile("a/b", root, join(home, ".pi/agent"))).toBeUndefined();
	});
});
