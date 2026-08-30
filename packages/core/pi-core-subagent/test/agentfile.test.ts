import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAgentFileCache, resolveAgentFile } from "../src/agentfile.ts";

let root: string;
let home: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "agentfile-"));
	home = mkdtempSync(join(tmpdir(), "agentfile-home-"));
	clearAgentFileCache();
});
afterAll(() => {
	clearAgentFileCache();
	rmSync(root, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
}

const ARCHITECT =
	"---\nname: frndos-architect\ndescription: Cross-service integration reviewer teammate — reviews how services work together during Agent Teams parallel execution\nmodel: claude-opus-4-6\n---\nYou are the architect.";
const ENGINEER =
	"---\nname: frndos-engineer\ndescription: Per-service engineer teammate — implements, self-reviews, creates PR for a single service during Agent Teams parallel execution\n---\nYou are the engineer.";
const BRAINSTORM =
	"---\nname: frndos-brainstorm\ndescription: Multi-choice brainstorming grounded in latest service state — sharpens scope before PRD\n---\nYou are the brainstormer.";

describe("resolveAgentFile (description matching)", () => {
	beforeEach(() => {
		clearAgentFileCache();
	});

	beforeAll(() => {
		write(".claude/agents/frndos-architect.md", ARCHITECT);
		write(".claude/agents/frndos-engineer.md", ENGINEER);
		write(".claude/agents/frndos-brainstorm.md", BRAINSTORM);
	});

	test("matches by goal, not by name — different name, same goal", () => {
		const hit = resolveAgentFile(
			"some-invented-name",
			"review how the auth service and billing service work together",
			root,
			join(home, ".pi/agent"),
		);
		expect(hit?.body).toBe("You are the architect.");
		expect(hit?.model).toBe("claude-opus-4-6");
	});

	test("implements/create-a-PR goal lands on the engineer", () => {
		const hit = resolveAgentFile(
			"implementer",
			"implement the payments service and create a PR",
			root,
			join(home, ".pi/agent"),
		);
		expect(hit?.body).toBe("You are the engineer.");
	});

	test("brainstorming goal (ing-stemmed) lands on the brainstormer", () => {
		const hit = resolveAgentFile(
			"planner",
			"brainstorm the scope of the new feature before the PRD",
			root,
			join(home, ".pi/agent"),
		);
		expect(hit?.body).toBe("You are the brainstormer.");
	});

	test("no overlap → undefined (inline on-demand unaffected)", () => {
		expect(resolveAgentFile("auditor", "count lines of code in src", root, join(home, ".pi/agent"))).toBeUndefined();
	});

	test("frontmatter tools parsed", () => {
		write(".claude/agents/reader.md", "---\ndescription: reads files and greps for symbols\n---\nRead.");
		const hit = resolveAgentFile("x", "grep for the symbol in the file", root, join(home, ".pi/agent"));
		expect(hit?.body).toBe("Read.");
	});

	test(".agents/agents beats .claude/agents (single source), same description", () => {
		write(".agents/agents/frndos-architect.md", ARCHITECT);
		clearAgentFileCache();
		const hit = resolveAgentFile("whatever", "review how services work together", root, join(home, ".pi/agent"));
		expect(hit?.body).toBe("You are the architect.");

		write(".agents/agents/frndos-architect.md", ARCHITECT.replace("claude-opus-4-6", "gemma"));
		clearAgentFileCache();
		const hit2 = resolveAgentFile("whatever", "review how services work together", root, join(home, ".pi/agent"));
		expect(hit2?.model).toBe("gemma");
	});

	test("filler-word overlap does not bind unrelated goals (real frndos false positives)", () => {
		write(
			".claude/agents/frndos-prd.md",
			"---\ndescription: Creates formal PRDs from Lark notes or user descriptions\nmodel: claude-opus-5\n---\nPRD writer.",
		);
		clearAgentFileCache();
		const agentDir = join(home, ".pi/agent");
		const goals: [string, string][] = [
			["web-editor", "Analyze web changes from 687ef3c7b to 09d7036f7. Find top end-user facing changes"],
			["release-audit", "Audit the release: verify version bumps and changelog entries"],
			["code-archaeologist", "Trace the history of this module and describe how it evolved"],
			["git-statistics", "Compute commit counts and churn per author"],
		];
		for (const [name, task] of goals) {
			expect(resolveAgentFile(name, task, root, agentDir)?.body).not.toBe("PRD writer.");
		}

		expect(resolveAgentFile("writer", "write the formal PRD from the Lark notes", root, agentDir)?.body).toBe(
			"PRD writer.",
		);
	});

	test("-e nouns survive the plural stemmer (services/service, files/file)", () => {
		write(
			".claude/agents/svc.md",
			"---\ndescription: Audits services and their config files across packages\n---\nSvc.",
		);
		clearAgentFileCache();
		expect(
			resolveAgentFile("a", "audit the service config file in this package", root, join(home, ".pi/agent"))?.body,
		).toBe("Svc.");
	});

	test("a detailed description is not harder to match than a lazy one", () => {
		write(
			".claude/agents/detailed-reviewer.md",
			"---\ndescription: Reviews TypeScript pull requests for correctness, performance, security, style; checks test coverage, flags breaking API changes, suggests refactors across monorepo packages\n---\nDetailed.",
		);
		clearAgentFileCache();
		expect(resolveAgentFile("reviewer", "review the pull request", root, join(home, ".pi/agent"))?.body).toBe(
			"Detailed.",
		);
	});

	test("nearest ancestor wins over a farther one", () => {
		write(
			"packages/core/.claude/agents/near.md",
			"---\ndescription: audits database migrations and rollback plans\n---\nNear.",
		);
		const hit = resolveAgentFile(
			"m",
			"audit the database migration rollback plan",
			join(root, "packages/core/sub"),
			join(home, ".pi/agent"),
		);
		expect(hit?.body).toBe("Near.");
	});

	test("home fallback: ~/.agents/agents before ~/.claude/agents", () => {
		for (const sub of [".agents/agents", ".claude/agents", ".pi/agents"])
			mkdirSync(join(home, sub), { recursive: true });
		writeFileSync(
			join(home, ".agents/agents/global.md"),
			"---\ndescription: audits npm publish credentials and token scopes\n---\nG-agents.",
		);
		writeFileSync(
			join(home, ".claude/agents/global.md"),
			"---\ndescription: audits npm publish credentials and token scopes\n---\nG-claude.",
		);
		const hit = resolveAgentFile("n", "audit the npm publish token scope", root, join(home, ".pi/agent"));
		expect(hit?.body).toBe("G-agents.");
	});

	test("project beats home", () => {
		clearAgentFileCache();
		const hit = resolveAgentFile("n", "audit the npm publish token scope", root, join(home, ".pi/agent"));
		expect(hit?.body).toBe("G-agents.");
		write(".pi/agents/local.md", "---\ndescription: audits npm publish credentials and token scopes\n---\nP.");
		clearAgentFileCache();
		const hit2 = resolveAgentFile("n", "audit the npm publish token scope", root, join(home, ".pi/agent"));
		expect(hit2?.body).toBe("P.");
	});
});
