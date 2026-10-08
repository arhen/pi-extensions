import { describe, expect, test } from "bun:test";
import {
	applyResumeOverrides,
	applySubagentModel,
	applySubagentThinking,
	cycleList,
	describeTools,
	formatStandby,
	formatWorkingMessage,
	isDefaultModeName,
	isToolPreset,
	nextInCycle,
	normalizeModeEntry,
	normalizeThinking,
	normalizeTools,
	parseToolList,
	resolveToolNames,
	thinkingLevelsFor,
} from "./logic.ts";
import type { Mode } from "./types.ts";

const KNOWN = ["read", "bash", "edit", "write", "grep", "find", "ls", "questionnaire", "subagent"];

function mode(name: string, enabled = true): Mode {
	return { name, enabled, tools: "default", leaderOverride: false };
}

describe("normalizeTools", () => {
	test("accepts presets", () => {
		expect(normalizeTools("plan")).toBe("plan");
		expect(normalizeTools("build")).toBe("build");
		expect(normalizeTools("default")).toBe("default");
	});

	test("sanitizes custom lists", () => {
		expect(normalizeTools(["read", "edit"])).toEqual(["read", "edit"]);
		expect(normalizeTools([])).toBe("default");
		expect(normalizeTools("nonsense")).toBe("default");
	});

	test("isToolPreset", () => {
		expect(isToolPreset("plan")).toBe(true);
		expect(isToolPreset("nope")).toBe(false);
	});
});

describe("normalizeModeEntry", () => {
	test("skips the reserved default name", () => {
		expect(normalizeModeEntry("default", {})).toBeUndefined();
		expect(normalizeModeEntry("  ", {})).toBeUndefined();
	});

	test("fills defaults and trims", () => {
		const mode = normalizeModeEntry(" review ", { instructions: "be careful", model: " p/m ", thinking: "high" });
		expect(mode).toEqual({
			name: "review",
			enabled: true,
			color: undefined,
			description: undefined,
			instructions: "be careful",
			tools: "default",
			model: "p/m",
			thinking: "high",
			subagentModel: undefined,
			subagentThinking: undefined,
			leaderOverride: false,
		});
	});

	test("leaderOverride is opt-in: only a literal true allows overrides", () => {
		expect(normalizeModeEntry("x", {})?.leaderOverride).toBe(false);
		expect(normalizeModeEntry("x", { leaderOverride: "yes" })?.leaderOverride).toBe(false);
		expect(normalizeModeEntry("x", { leaderOverride: true })?.leaderOverride).toBe(true);
	});

	test("drops invalid thinking levels", () => {
		expect(normalizeModeEntry("x", { thinking: "turbo", subagentThinking: 5 })?.thinking).toBeUndefined();
		expect(normalizeModeEntry("x", { thinking: "turbo" })?.subagentThinking).toBeUndefined();
	});

	test("respects disabled", () => {
		expect(normalizeModeEntry("x", { enabled: false })?.enabled).toBe(false);
	});
});

describe("resolveToolNames", () => {
	test("default keeps the base set", () => {
		expect(resolveToolNames("default", ["read", "bash", "subagent"], KNOWN)).toEqual(["read", "bash", "subagent"]);
	});

	test("plan drops write tools and keeps read-only ones", () => {
		expect(resolveToolNames("plan", ["read", "bash", "edit", "write", "subagent"], KNOWN)).toEqual([
			"read",
			"bash",
			"subagent",
			"grep",
			"find",
			"ls",
		]);
	});

	test("build restores write tools and keeps extras", () => {
		expect(resolveToolNames("build", ["read", "subagent"], KNOWN)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"subagent",
		]);
	});

	test("custom filters unknown tools", () => {
		expect(resolveToolNames(["read", "ghost", "edit", "edit"], ["read"], KNOWN)).toEqual(["read", "edit"]);
	});

	test("empty custom falls back to build", () => {
		expect(resolveToolNames(["ghost"], [], KNOWN)).toEqual(["read", "bash", "edit", "write"]);
	});
});

describe("cycle", () => {
	const modes = [mode("alpha"), mode("beta", false), mode("gamma")];

	test("only enabled modes plus default", () => {
		expect(cycleList(modes)).toEqual(["default", "alpha", "gamma"]);
	});

	test("forward wraps", () => {
		const list = cycleList(modes);
		expect(nextInCycle(list, undefined, 1)).toBe("alpha");
		expect(nextInCycle(list, "gamma", 1)).toBe("default");
		expect(nextInCycle(list, "default", -1)).toBe("gamma");
	});

	test("unknown current starts at an edge", () => {
		expect(nextInCycle(["default", "a"], "ghost", 1)).toBe("default");
	});
});

describe("subagent model injection", () => {
	test("fills tasks and chain, leaving explicit models alone", () => {
		const input: Record<string, unknown> = {
			tasks: [
				{ agent: "a", task: "t" },
				{ agent: "b", task: "t", model: "x/y" },
			],
			chain: [{ agent: "c", task: "t" }],
		};
		expect(applySubagentModel(input, "openai-codex/gpt")).toBe(true);
		expect(input.tasks).toEqual([
			{ agent: "a", task: "t", model: "openai-codex/gpt" },
			{ agent: "b", task: "t", model: "x/y" },
		]);
		expect(input.chain).toEqual([{ agent: "c", task: "t", model: "openai-codex/gpt" }]);
	});

	test("reports no change when every task pins its own model", () => {
		const input: Record<string, unknown> = { tasks: [{ agent: "a", task: "t", model: "p/m" }] };
		expect(applySubagentModel(input, "p/m")).toBe(false);
	});

	test("patches single mode", () => {
		const input: Record<string, unknown> = { agent: "a", task: "t" };
		expect(applySubagentModel(input, "p/m")).toBe(true);
		expect(input.model).toBe("p/m");
	});

	test("leaves unrelated input alone", () => {
		const input: Record<string, unknown> = { command: "ls" };
		expect(applySubagentModel(input, "p/m")).toBe(false);
	});

	test("force replaces the leader's model and thinking on every task", () => {
		const input: Record<string, unknown> = {
			tasks: [
				{ agent: "a", task: "t", model: "9router/cc/claude-opus-5-5", thinking: "high" },
				{ agent: "b", task: "t" },
			],
		};
		expect(applySubagentModel(input, "opencode-go/deepseek-v4.1-flash", true)).toBe(true);
		expect(applySubagentThinking(input, "max", true)).toBe(true);
		expect(input.tasks).toEqual([
			{ agent: "a", task: "t", model: "opencode-go/deepseek-v4.1-flash", thinking: "max" },
			{ agent: "b", task: "t", model: "opencode-go/deepseek-v4.1-flash", thinking: "max" },
		]);
		expect(applySubagentModel(input, "opencode-go/deepseek-v4.1-flash", true)).toBe(false);
	});

	test("force applies to single mode too", () => {
		const input: Record<string, unknown> = { agent: "a", task: "t", model: "x/y", thinking: "low" };
		applySubagentModel(input, "p/m", true);
		applySubagentThinking(input, "max", true);
		expect([input.model, input.thinking]).toEqual(["p/m", "max"]);
	});

	test("resume overrides replace the leader's model and thinking", () => {
		const input: Record<string, unknown> = { runId: "r", taskId: "t", model: "x/y" };
		expect(applyResumeOverrides(input, "p/m", "max")).toBe(true);
		expect(input).toEqual({ runId: "r", taskId: "t", model: "p/m", thinking: "max" });
		expect(applyResumeOverrides(input, undefined, undefined)).toBe(false);
	});
});

describe("thinking", () => {
	test("normalizeThinking accepts known levels only", () => {
		expect(normalizeThinking("high")).toBe("high");
		expect(normalizeThinking("off")).toBe("off");
		expect(normalizeThinking("ultra")).toBeUndefined();
		expect(normalizeThinking(3)).toBeUndefined();
	});

	test("thinkingLevelsFor follows model reasoning support", () => {
		expect(thinkingLevelsFor(undefined)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(thinkingLevelsFor({ reasoning: false })).toEqual(["off"]);
		expect(thinkingLevelsFor({ reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(thinkingLevelsFor({ reasoning: true, thinkingLevelMap: { minimal: null, low: null } })).toEqual([
			"off",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	test("subagent thinking fills the gaps, leaving explicit values alone", () => {
		const input: Record<string, unknown> = {
			tasks: [
				{ agent: "a", task: "t" },
				{ agent: "b", task: "t", thinking: "low" },
			],
		};
		expect(applySubagentThinking(input, "xhigh")).toBe(true);
		expect(input.tasks).toEqual([
			{ agent: "a", task: "t", thinking: "xhigh" },
			{ agent: "b", task: "t", thinking: "low" },
		]);
	});

	test("subagent thinking patched in single mode", () => {
		const input: Record<string, unknown> = { agent: "a", task: "t" };
		expect(applySubagentThinking(input, "medium")).toBe(true);
		expect(input.thinking).toBe("medium");
	});
});

describe("formatting", () => {
	test("working and standby text", () => {
		expect(formatWorkingMessage("review")).toBe("review is working...");
		expect(formatStandby("review")).toBe("review standby");
	});

	test("tool list parsing and describe", () => {
		expect(parseToolList("read, bash\nedit  read")).toEqual(["read", "bash", "edit"]);
		expect(describeTools(["read", "bash"])).toBe("read, bash");
		expect(describeTools("plan")).toBe("plan");
	});

	test("default name check", () => {
		expect(isDefaultModeName(" default ")).toBe(true);
		expect(isDefaultModeName("other")).toBe(false);
	});
});
