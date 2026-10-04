import { expect, test } from "bun:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderModelCatalog } from "../src/format.ts";
import { parsePreferences } from "../src/modelconfig.ts";
import { listSelectableModels, supportedThinkingLevels } from "../src/models.ts";

function model(overrides: Record<string, unknown> = {}) {
	return {
		provider: "probe",
		id: "local",
		name: "Probe",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		contextWindow: 8192,
		maxTokens: 512,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as never;
}

function context(candidate: ReturnType<typeof model>): ExtensionContext {
	return {
		model: candidate,
		scopedModels: [{ model: candidate }],
		modelRegistry: {
			getAvailable: () => [candidate],
			find: () => candidate,
		},
	} as unknown as ExtensionContext;
}

const noPreferences = { prefer: [], hide: [], path: "probe-config" };

function catalogText(candidate: ReturnType<typeof model>): string {
	return renderModelCatalog(listSelectableModels(context(candidate), noPreferences)).content[0]?.text ?? "";
}

test("invalid preferences do not hide models or suggest a default", () => {
	const candidate = model();
	const prefs = parsePreferences('{"hide":["*"],"default":"probe/missing","typo":true}', "probe-config");
	const catalog = listSelectableModels(context(candidate), prefs);
	expect(catalog.models).toHaveLength(1);
	expect(catalog.configError).toContain("unknown key");
	expect(catalog.preferredDefault).toBeUndefined();
});

test("discovery advertises only thinking levels the runtime honors", () => {
	const candidate = model({ reasoning: true, thinkingLevelMap: { off: null, low: "low", high: "high" } });
	expect(supportedThinkingLevels(candidate)).toEqual(getSupportedThinkingLevels(candidate));
	expect(supportedThinkingLevels(candidate)).not.toContain("off");
});

test("positive cache rates prevent a free model label", () => {
	const text = catalogText(model({ cost: { input: 0, output: 0, cacheRead: 2, cacheWrite: 3 } }));
	expect(text).not.toContain("price: free");
	expect(text).toContain("cache-read $2.00");
	expect(text).toContain("cache-write $3.00");
});

test("unreported cache rates are not presented as free", () => {
	const text = catalogText(model({ cost: { input: 0, output: 0 } }));
	expect(text).not.toContain("price: free");
	expect(text).toContain("cache-read unavailable");
	expect(text).toContain("cache-write unavailable");
});

test("unlisted config defaults are not advertised as selectable references", () => {
	const candidate = model();
	const catalog = listSelectableModels(context(candidate), { ...noPreferences, default: "probe/missing" });
	expect(catalog.preferredDefault).toBeUndefined();
	const text = renderModelCatalog(catalog).content[0]?.text ?? "";
	expect(text).toContain("probe/missing");
	expect(text).not.toContain('model: "probe/missing"');
});
