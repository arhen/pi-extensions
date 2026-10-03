import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyPreferences,
	loadPreferences,
	MODEL_CONFIG_FILENAME,
	matchesPattern,
	parsePreferences,
} from "../src/modelconfig.ts";

describe("matchesPattern", () => {
	test("a bare provider matches every model from that provider", () => {
		expect(matchesPattern("openai-codex/gpt-5.6-luna", "openai-codex")).toBe(true);
		expect(matchesPattern("openai-codex", "openai-codex")).toBe(true);
		expect(matchesPattern("openai/gpt-5", "openai-codex")).toBe(false);
	});
	test("patterns match the whole provider/id, not a fragment", () => {
		expect(matchesPattern("openai-codex/gpt-5.6-luna", "openai-codex/*")).toBe(true);
		expect(matchesPattern("openai-codex/gpt-5.6-luna", "gpt-5.6-*")).toBe(false);
	});
	test("matching is case-insensitive", () => {
		expect(matchesPattern("OpenAI-Codex/GPT-5.6-Luna", "openai-codex/gpt-5.6-*")).toBe(true);
	});
	test("regex metacharacters in a pattern are literal", () => {
		expect(matchesPattern("p/m+1", "p/m+1")).toBe(true);
		expect(matchesPattern("p/mm1", "p/m+1")).toBe(false);
		expect(matchesPattern("p/m.1", "p/m*")).toBe(true);
	});
	test("an empty pattern matches nothing", () => {
		expect(matchesPattern("p/m", "  ")).toBe(false);
	});
});

describe("parsePreferences", () => {
	test("reads prefer, hide and default", () => {
		const prefs = parsePreferences(JSON.stringify({ prefer: ["p/*"], hide: ["q"], default: "p/m" }), "f.json");
		expect(prefs).toEqual({ prefer: ["p/*"], hide: ["q"], default: "p/m", path: "f.json" });
	});
	test("malformed JSON is reported, not thrown", () => {
		const prefs = parsePreferences("{ nope", "f.json");
		expect(prefs.error).toContain("not valid JSON");
		expect(prefs.prefer).toEqual([]);
	});
	test("a non-object is reported", () => {
		expect(parsePreferences("[]", "f.json").error).toBe("must be a JSON object");
	});
	test("unknown keys are reported and all preferences are skipped", () => {
		const prefs = parsePreferences(
			JSON.stringify({ prefer: ["p/*"], hide: ["*"], default: "p/m", hidden: ["q"] }),
			"f.json",
		);
		expect(prefs.error).toContain("unknown key(s): hidden");
		expect(prefs.prefer).toEqual([]);
		expect(prefs.hide).toEqual([]);
		expect(prefs.default).toBeUndefined();
	});
	test("wrong-typed fields are reported and dropped", () => {
		const prefs = parsePreferences(JSON.stringify({ prefer: "p/*", hide: [7, ""], default: 42 }), "f.json");
		expect(prefs.error).toContain("prefer must be an array of strings");
		expect(prefs.error).toContain("hide contains a non-string entry");
		expect(prefs.error).toContain("default must be a non-empty string");
		expect(prefs.prefer).toEqual([]);
	});
});

describe("loadPreferences", () => {
	test("a missing file is no preferences, with no error", () => {
		const dir = mkdtempSync(join(tmpdir(), "prefs-"));
		const prefs = loadPreferences(dir);
		expect(prefs.path).toBe(join(dir, MODEL_CONFIG_FILENAME));
		expect(prefs).toMatchObject({ prefer: [], hide: [] });
		expect(prefs.error).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});
	test("an unreadable file degrades to no preferences with the reason", () => {
		const dir = mkdtempSync(join(tmpdir(), "prefs-"));
		const path = join(dir, MODEL_CONFIG_FILENAME);
		writeFileSync(path, "{ broken");
		const prefs = loadPreferences(dir);
		expect(prefs.error).toContain("not valid JSON");
		expect(prefs.path).toBe(path);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("applyPreferences", () => {
	const entries = [{ reference: "p/a" }, { reference: "q/b" }, { reference: "p/c" }];
	test("hide omits matching entries and reports the count", () => {
		const { entries: shown, unusedPatterns } = applyPreferences(entries, { prefer: [], hide: ["p/*"], path: "f" });
		expect(shown.map((e) => e.reference)).toEqual(["q/b"]);
		expect(unusedPatterns).toEqual([]);
	});
	test("prefer sorts matches first in declaration order, the rest stable", () => {
		const { entries: shown } = applyPreferences(entries, { prefer: ["p/c", "q/*"], hide: [], path: "f" });
		expect(shown.map((e) => e.reference)).toEqual(["p/c", "q/b", "p/a"]);
	});
	test("patterns that matched nothing are reported, so an inert config is not silent", () => {
		const { unusedPatterns } = applyPreferences(entries, { prefer: ["nope/*"], hide: ["p/a", "gone"], path: "f" });
		expect(unusedPatterns).toEqual(["gone", "nope/*"]);
	});
	test("hiding is a display filter only, never a removal from the model list handed in", () => {
		const copy = [...entries];
		applyPreferences(copy, { prefer: [], hide: ["p/*", "q/*"], path: "f" });
		expect(copy).toHaveLength(3);
	});
});
