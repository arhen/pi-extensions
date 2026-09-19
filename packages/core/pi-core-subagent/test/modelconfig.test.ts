import { describe, expect, test } from "bun:test";
import { applyPreferences, matchesPattern, parsePreferences } from "../src/modelconfig.ts";

describe("matchesPattern", () => {
	test("a bare provider matches that provider's models and nothing else", () => {
		expect(matchesPattern("openai-codex/gpt-5.6-luna", "openai-codex")).toBe(true);
		expect(matchesPattern("openai-codex/gpt-6-astra", "openai-codex")).toBe(true);
		// The near-miss that a naive startsWith would get wrong.
		expect(matchesPattern("openai-codex-v2/x", "openai-codex")).toBe(false);
		expect(matchesPattern("deepseek/deepseek-v4-pro", "openai-codex")).toBe(false);
	});
	test("an exact reference matches only itself", () => {
		expect(matchesPattern("openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-luna")).toBe(true);
		expect(matchesPattern("openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna")).toBe(false);
	});
	test("a glob spans the whole reference, not a prefix", () => {
		expect(matchesPattern("openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-*")).toBe(true);
		expect(matchesPattern("openai-codex/gpt-5.6-luna", "*/gpt-5.6-luna")).toBe(true);
		expect(matchesPattern("openai-codex/gpt-5.6-luna", "*gpt*")).toBe(true);
		// Anchored: a partial tail must not match.
		expect(matchesPattern("openai-codex/gpt-5.6-luna", "gpt-5.6-*")).toBe(false);
	});
	test("regex metacharacters in a pattern are literal, not active", () => {
		expect(matchesPattern("p/a.b", "p/a.b")).toBe(true);
		expect(matchesPattern("p/axb", "p/a.b")).toBe(false);
		expect(matchesPattern("p/a+b", "p/a+b")).toBe(true);
	});
	test("case and whitespace are ignored, and an empty pattern matches nothing", () => {
		expect(matchesPattern("OpenAI-Codex/GPT-5.6-Luna", "openai-codex/*")).toBe(true);
		expect(matchesPattern("p/m", "  p/m  ")).toBe(true);
		expect(matchesPattern("p/m", "")).toBe(false);
		expect(matchesPattern("p/m", "   ")).toBe(false);
	});
});

describe("parsePreferences", () => {
	test("a well-formed file yields its fields", () => {
		const prefs = parsePreferences(
			JSON.stringify({ prefer: ["openai-codex/*"], hide: ["mlx-lm"], default: "openai-codex/gpt-5.6-luna" }),
		);
		expect(prefs.prefer).toEqual(["openai-codex/*"]);
		expect(prefs.hide).toEqual(["mlx-lm"]);
		expect(prefs.default).toBe("openai-codex/gpt-5.6-luna");
		expect(prefs.error).toBeUndefined();
	});
	test("a blank default is not applied", () => {
		const prefs = parsePreferences(JSON.stringify({ default: "   " }));
		expect(prefs.default).toBeUndefined();
		expect(prefs.error).toContain("default");
	});
	test("malformed JSON degrades to no preferences with an error, never a throw", () => {
		const prefs = parsePreferences("{ not json");
		expect(prefs.prefer).toEqual([]);
		expect(prefs.hide).toEqual([]);
		expect(prefs.error).toContain("not valid JSON");
	});
	test("a non-object, an unknown key, and a wrong-typed field are all reported", () => {
		expect(parsePreferences("[]").error).toContain("must be a JSON object");
		expect(parsePreferences(JSON.stringify({ prefer: ["a"], typo: 1 })).error).toContain("unknown key(s): typo");
		const wrong = parsePreferences(JSON.stringify({ hide: "mlx-lm" }));
		expect(wrong.hide).toEqual([]);
		expect(wrong.error).toContain("hide must be an array");
		expect(parsePreferences(JSON.stringify({ prefer: ["ok", 7] })).error).toContain("non-string entry");
	});
	test("an empty object is valid and means no preferences", () => {
		const prefs = parsePreferences("{}");
		expect(prefs.error).toBeUndefined();
		expect(prefs.prefer).toEqual([]);
		expect(prefs.hide).toEqual([]);
	});
});

describe("applyPreferences", () => {
	const entries = [
		{ reference: "deepseek/deepseek-v4-flash" },
		{ reference: "openai-codex/gpt-6-astra" },
		{ reference: "mlx-lm/local" },
		{ reference: "openai-codex/gpt-5.6-luna" },
		{ reference: "mesh/gemma" },
	];
	const prefs = (o: Partial<{ prefer: string[]; hide: string[] }>) => ({
		prefer: o.prefer ?? [],
		hide: o.hide ?? [],
		path: "test",
	});

	test("hide removes matches and nothing else", () => {
		const out = applyPreferences(entries, prefs({ hide: ["mlx-lm", "mesh"] })).entries;
		expect(out.map((e) => e.reference)).toEqual([
			"deepseek/deepseek-v4-flash",
			"openai-codex/gpt-6-astra",
			"openai-codex/gpt-5.6-luna",
		]);
	});
	test("prefer sorts first, in declaration order, keeping the rest stable", () => {
		const out = applyPreferences(entries, prefs({ prefer: ["openai-codex/gpt-5.6-luna", "openai-codex"] })).entries;
		expect(out.map((e) => e.reference)).toEqual([
			"openai-codex/gpt-5.6-luna", // rank 0
			"openai-codex/gpt-6-astra", // rank 1, via the provider pattern
			"deepseek/deepseek-v4-flash", // unranked, original order preserved
			"mlx-lm/local",
			"mesh/gemma",
		]);
	});
	test("hide beats prefer when a model matches both", () => {
		const out = applyPreferences(
			entries,
			prefs({ prefer: ["openai-codex"], hide: ["openai-codex/gpt-6-astra"] }),
		).entries;
		expect(out.map((e) => e.reference)).not.toContain("openai-codex/gpt-6-astra");
		expect(out[0]!.reference).toBe("openai-codex/gpt-5.6-luna");
	});
	test("no preferences leaves the order untouched", () => {
		expect(applyPreferences(entries, prefs({})).entries.map((e: { reference: string }) => e.reference)).toEqual(
			entries.map((e) => e.reference),
		);
	});
	test("hiding everything yields an empty list rather than throwing", () => {
		expect(applyPreferences(entries, prefs({ hide: ["*"] })).entries).toEqual([]);
	});
	test("an inert pattern is reported instead of silently doing nothing", () => {
		// This is the trap: hide a model that is not enabled, see it absent, and assume the config
		// worked. The absence is coincidental, and the pattern would never take effect.
		const inert = applyPreferences(entries, prefs({ hide: ["mlx-lm"] }));
		expect(inert.unusedPatterns).toEqual([]);
		const nothing = applyPreferences(entries, prefs({ hide: ["gemini/*"], prefer: ["anthropic/*"] }));
		expect(nothing.unusedPatterns).toEqual(["gemini/*", "anthropic/*"]);
		expect(nothing.entries).toHaveLength(entries.length);
	});
	test("a pattern that matched is not reported as unused", () => {
		const out = applyPreferences(entries, prefs({ hide: ["mlx-lm", "gemini/*"] }));
		expect(out.unusedPatterns).toEqual(["gemini/*"]);
	});
});
