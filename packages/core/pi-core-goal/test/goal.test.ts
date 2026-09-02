import { expect, test } from "bun:test";

import { assistantUsageTokens, normalizeStatus, statusAfterObjectiveEdit, validateObjective } from "../src/index.ts";

test("validateObjective trims and rejects empty/overlong", () => {
	expect(validateObjective("  ship it  ")).toBe("ship it");
	expect(() => validateObjective("   ")).toThrow();
	expect(() => validateObjective("x".repeat(4001))).toThrow();
});

test("normalizeStatus maps aliases and defaults to active", () => {
	expect(normalizeStatus("usage_limited")).toBe("usageLimited");
	expect(normalizeStatus("budget_limited")).toBe("budgetLimited");
	expect(normalizeStatus("paused")).toBe("paused");
	expect(normalizeStatus("garbage")).toBe("active");
	expect(normalizeStatus(undefined)).toBe("active");
});

test("assistantUsageTokens counts input minus cacheRead plus output", () => {
	const messages = [
		{ role: "user" },
		{ role: "assistant", usage: { input: 1000, output: 200, cacheRead: 800 } },
		{ role: "assistant", usage: { input: 500, output: 100, cacheRead: 0 } },
		{ role: "assistant", usage: { totalTokens: 50 } },
	];
	expect(assistantUsageTokens(messages)).toBe(400 + 600 + 50);
	expect(assistantUsageTokens([])).toBe(0);
});

test("statusAfterObjectiveEdit reactivates only terminal states", () => {
	expect(statusAfterObjectiveEdit("complete")).toBe("active");
	expect(statusAfterObjectiveEdit("budgetLimited")).toBe("active");
	expect(statusAfterObjectiveEdit("paused")).toBe("paused");
	expect(statusAfterObjectiveEdit("blocked")).toBe("blocked");
	expect(statusAfterObjectiveEdit("usageLimited")).toBe("usageLimited");
});
