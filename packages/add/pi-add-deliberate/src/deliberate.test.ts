import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	atomicWriteFile,
	DEFAULT_PLAN_PATH,
	filterTools,
	latestPlanEntry,
	loadConfig,
	parseConfig,
	planWidgetLines,
	resolvePlanPath,
	validatePlanMarkdown,
} from "./config.ts";
import { resolveThinkingLevel, selectableModels, supportedThinkingLevels } from "./models.ts";
import { clampOffset, parseWheelInput, sliceViewport } from "./viewer.ts";

function model(provider: string, id: string, extra: Partial<Model<any>> = {}): Model<any> {
	return { provider, id, reasoning: false, ...extra } as unknown as Model<any>;
}

describe("config validation", () => {
	test("accepts a full valid config", () => {
		const parsed = parseConfig({
			advise: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinking: "high", tools: ["read", "grep"] },
			plan: { model: { provider: "openai", id: "gpt-5" }, thinking: "medium", tools: ["read"], path: "docs/PLAN.md" },
		});
		expect("value" in parsed).toBe(true);
		if ("value" in parsed) {
			expect(parsed.value.advise?.model?.provider).toBe("anthropic");
			expect(parsed.value.plan?.path).toBe("docs/PLAN.md");
		}
	});

	test("rejects unknown top-level and mode keys", () => {
		expect(parseConfig({ nope: {} })).toEqual({ error: 'unknown key "nope"' });
		expect("error" in parseConfig({ advise: { path: "x" } })).toBe(true);
		expect("error" in parseConfig({ plan: { mode: "x" } })).toBe(true);
	});

	test("rejects wrong types and out-of-range values", () => {
		expect("error" in parseConfig(null)).toBe(true);
		expect("error" in parseConfig({ advise: "read" })).toBe(true);
		expect("error" in parseConfig({ advise: { model: { provider: "", id: "x" } } })).toBe(true);
		expect("error" in parseConfig({ advise: { model: { provider: "a", id: "b", extra: 1 } } })).toBe(true);
		expect("error" in parseConfig({ advise: { thinking: "banana" } })).toBe(true);
		expect("error" in parseConfig({ advise: { tools: "read" } })).toBe(true);
		expect("error" in parseConfig({ plan: { path: "   " } })).toBe(true);
	});

	test("allows an empty config object", () => {
		expect(parseConfig({})).toEqual({ value: {} });
	});

	test("loadConfig treats missing, malformed, and invalid files as unconfigured", async () => {
		const dir = await mkdtemp(join(tmpdir(), "deliberate-config-"));
		try {
			expect((await loadConfig(dir)).config).toBeNull();
			await writeFile(join(dir, "deliberate.json"), "not json");
			const malformed = await loadConfig(dir);
			expect(malformed.config).toBeNull();
			expect(malformed.error).toBeString();
			await writeFile(join(dir, "deliberate.json"), JSON.stringify({ plan: { path: "P.md", extra: 1 } }));
			const invalid = await loadConfig(dir);
			expect(invalid.config).toBeNull();
			expect(invalid.error).toBeString();
			await writeFile(join(dir, "deliberate.json"), JSON.stringify({ plan: { path: "P.md" } }));
			const valid = await loadConfig(dir);
			expect(valid.config?.plan?.path).toBe("P.md");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("tool filtering", () => {
	test("advise keeps only the read-only allowlist and dedupes", () => {
		expect(filterTools("advise", ["edit", "write", "read", "bash", "read", "subagent"])).toEqual(["read", "bash"]);
	});
	test("plan drops bash/edit/write", () => {
		expect(filterTools("plan", ["bash", "grep", "edit", "ls", "write"])).toEqual(["grep", "ls"]);
	});
	test("defaults apply when tools are absent or fully filtered", () => {
		expect(filterTools("advise")).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(filterTools("plan")).toEqual(["read", "grep", "find", "ls"]);
		expect(filterTools("plan", [])).toEqual(["read", "grep", "find", "ls"]);
		expect(filterTools("advise", ["edit", "write"])).toEqual(["read", "grep", "find", "ls", "bash"]);
	});
});

describe("plan path resolution", () => {
	const cwd = "/work/project";
	const home = "/home/tester";
	test("default and relative paths resolve from cwd", () => {
		expect(resolvePlanPath(undefined, cwd, home)).toBe(join(cwd, DEFAULT_PLAN_PATH));
		expect(resolvePlanPath("docs/PLAN.md", cwd, home)).toBe(join(cwd, "docs/PLAN.md"));
	});
	test("absolute paths stay absolute", () => {
		expect(resolvePlanPath("/tmp/plan.md", cwd, home)).toBe("/tmp/plan.md");
	});
	test("~ and ~/ resolve from home", () => {
		expect(resolvePlanPath("~", cwd, home)).toBe(home);
		expect(resolvePlanPath("~/plans/p.md", cwd, home)).toBe(join(home, "plans/p.md"));
	});
});

describe("plan state", () => {
	test("latest plan entry on the branch wins, ignoring malformed data", () => {
		const branch = [
			{ type: "custom", customType: "deliberate-plan", data: { path: "/old.md", savedAt: "1" } },
			{ type: "message" },
			{ type: "custom", customType: "deliberate-plan", data: { path: "/new.md", savedAt: "2" } },
			{ type: "custom", customType: "other", data: { path: "/other.md" } },
		];
		expect(latestPlanEntry(branch)).toEqual({ path: "/new.md", savedAt: "2" });
	});
	test("malformed entries are skipped, not returned", () => {
		const branch = [
			{ type: "custom", customType: "deliberate-plan", data: { path: "/valid.md", savedAt: "1" } },
			{ type: "custom", customType: "deliberate-plan", data: { path: 42 } },
		];
		expect(latestPlanEntry(branch)).toEqual({ path: "/valid.md", savedAt: "1" });
	});
	test("no entry yields null and no widget lines", () => {
		expect(latestPlanEntry([])).toBeNull();
		expect(latestPlanEntry([{ type: "message" }])).toBeNull();
		expect(planWidgetLines({ path: "/p.md", savedAt: "1" })).toEqual(["📋 Plan: /p.md", "   /plan-view · Ctrl+Alt+P"]);
	});
});

describe("plan markdown and atomic writes", () => {
	test("empty or whitespace-only markdown is rejected", () => {
		expect(validatePlanMarkdown("")).toBeString();
		expect(validatePlanMarkdown("  \n ")).toBeString();
		expect(validatePlanMarkdown("# Plan")).toBeNull();
	});

	test("atomic write replaces content and leaves no temp files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "deliberate-"));
		try {
			const target = join(dir, "nested", "PLAN.md");
			await atomicWriteFile(target, "first\n");
			expect(await readFile(target, "utf8")).toBe("first\n");
			await atomicWriteFile(target, "second\n");
			expect(await readFile(target, "utf8")).toBe("second\n");
			const nested = await readdir(join(dir, "nested"));
			expect(nested).toEqual(["PLAN.md"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("model source and thinking", () => {
	test("scoped models win over available models", () => {
		const scoped = [{ model: model("openai", "gpt-5") }];
		const available = [model("anthropic", "claude-sonnet-4-5"), model("openai", "gpt-5")];
		expect(selectableModels(scoped, available).map((m) => `${m.provider}/${m.id}`)).toEqual(["openai/gpt-5"]);
	});

	test("empty scoped list falls back to available, deduped and sorted", () => {
		const available = [
			model("openai", "gpt-5"),
			model("anthropic", "claude-sonnet-4-5"),
			model("openai", "gpt-5"),
			model("anthropic", "claude-opus-4-6"),
		];
		expect(selectableModels([], available).map((m) => `${m.provider}/${m.id}`)).toEqual([
			"anthropic/claude-opus-4-6",
			"anthropic/claude-sonnet-4-5",
			"openai/gpt-5",
		]);
	});

	test("thinking levels come from the model and unsupported levels clamp", () => {
		const nonReasoning = model("openai", "gpt-4o");
		expect(supportedThinkingLevels(nonReasoning)).toEqual(["off"]);
		expect(resolveThinkingLevel(nonReasoning, "high")).toBe("off");

		const reasoning = model("anthropic", "claude-opus-4-6", {
			reasoning: true,
			thinkingLevelMap: { xhigh: null, max: null },
		});
		expect(supportedThinkingLevels(reasoning)).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(resolveThinkingLevel(reasoning, "max")).toBe("high");
		expect(resolveThinkingLevel(reasoning, "medium")).toBe("medium");
	});
});

describe("overlay viewport math", () => {
	const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);

	test("slice keeps a bounded window and clamps the offset", () => {
		expect(sliceViewport(lines, 0, 3).lines).toEqual(["line 0", "line 1", "line 2"]);
		expect(sliceViewport(lines, 100, 3)).toEqual({ offset: 7, lines: ["line 7", "line 8", "line 9"] });
		expect(sliceViewport(lines, -5, 3).offset).toBe(0);
		expect(sliceViewport(lines, 4, 1).lines).toEqual(["line 4"]);
	});

	test("clampOffset handles empty and short content", () => {
		expect(clampOffset(5, 0, 3)).toBe(0);
		expect(clampOffset(0, 2, 5)).toBe(0);
		expect(clampOffset(9, 10, 3)).toBe(7);
	});

	test("mouse wheel sequences map to scroll deltas", () => {
		expect(parseWheelInput("\u001b[<64;10;5M")).toBe(-1);
		expect(parseWheelInput("\u001b[<65;10;5M")).toBe(1);
		expect(parseWheelInput("\u001b[<0;10;5M")).toBeNull();
		expect(parseWheelInput("j")).toBeNull();
	});
});

describe("skill protocol text", () => {
	const advise = readFileSync(new URL("../skills/deliberate-advise/SKILL.md", import.meta.url), "utf8");
	const plan = readFileSync(new URL("../skills/deliberate-plan/SKILL.md", import.meta.url), "utf8");

	test("advise skill pins the prepare-first protocol and failure options", () => {
		for (const needle of [
			"deliberate_mode",
			'"action": "prepare"',
			"unconfigured",
			"dependency-missing",
			"model-unavailable",
			"ready",
			"/deliberate-config advise",
			'"write": false',
			'"autoAwait": true',
			"ask_user_question",
			"Skip mode",
			"Custom subagent",
			"Reconfigure mode",
			"Main agent handles",
			"no file changes",
		]) {
			expect(advise, `advise skill missing: ${needle}`).toContain(needle);
		}
	});

	test("plan skill pins the sections, save tool and viewer", () => {
		for (const needle of [
			"deliberate_mode",
			'"action": "prepare"',
			"unconfigured",
			"/deliberate-config plan",
			'"write": false',
			'"autoAwait": true',
			"deliberate_save_plan",
			"/plan-view",
			"Goal",
			"Context / assumptions",
			"Constraints",
			"Steps",
			"Tests / checks",
			"Risks",
			"Open questions",
			"never implement",
		]) {
			expect(plan, `plan skill missing: ${needle}`).toContain(needle);
		}
	});

	test("skills declare frontmatter names matching their directories", () => {
		expect(advise.startsWith("---\nname: deliberate-advise\n")).toBe(true);
		expect(plan.startsWith("---\nname: deliberate-plan\n")).toBe(true);
	});
});
