import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderModelCatalog } from "../src/format.ts";
import extension from "../src/index.ts";
import type { ModelPreferences } from "../src/modelconfig.ts";
import {
	chooseModel,
	listSelectableModels,
	normalizeCost,
	resolveChildModel,
	supportedThinkingLevels,
} from "../src/models.ts";

interface Fixture {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	cost?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, string | null>;
}

function fixture(over: Fixture): Fixture {
	return { name: over.id, reasoning: false, contextWindow: 4096, ...over };
}

function registryFor(models: Fixture[]) {
	return {
		getAvailable: () => models as never[],
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id) as never,
	};
}

function ctxFor(models: Fixture[], scoped?: Fixture[], session?: unknown): ExtensionContext {
	return {
		cwd: "/tmp",
		hasUI: false,
		model: session,
		scopedModels: scoped?.map((model) => ({ model })) as never,
		modelRegistry: registryFor(models),
	} as never as ExtensionContext;
}

describe("supportedThinkingLevels", () => {
	test("a non-reasoning model supports only off", () => {
		expect(supportedThinkingLevels(fixture({ provider: "p", id: "m" }) as never)).toEqual(["off"]);
	});
	test("levels come from pi's resolver: unmapped xhigh/max are not advertised", () => {
		const model = fixture({ provider: "p", id: "m", reasoning: true });
		expect(supportedThinkingLevels(model as never)).toEqual(["off", "minimal", "low", "medium", "high"]);
	});
	test("a null-mapped level is excluded; an explicitly mapped xhigh is kept", () => {
		const model = fixture({ provider: "p", id: "m", reasoning: true, thinkingLevelMap: { low: null, xhigh: "x" } });
		expect(supportedThinkingLevels(model as never)).toEqual(["off", "minimal", "medium", "high", "xhigh"]);
	});
	test("off is not advertised when the runtime would clamp it", () => {
		const model = fixture({ provider: "p", id: "m", reasoning: true, thinkingLevelMap: { off: null } });
		expect(supportedThinkingLevels(model as never)).not.toContain("off");
	});
});

describe("normalizeCost", () => {
	test("a missing or partial cost is unavailable, never free", () => {
		expect(normalizeCost(undefined)).toBeUndefined();
		expect(normalizeCost({})).toBeUndefined();
		expect(normalizeCost({ input: 3 })).toBeUndefined();
		expect(normalizeCost({ input: "3", output: 4 })).toBeUndefined();
		expect(normalizeCost({ input: -1, output: 4 })).toBeUndefined();
		expect(normalizeCost({ input: Number.NaN, output: 4 })).toBeUndefined();
	});
	test("zero rates are preserved as zero", () => {
		expect(normalizeCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});
	test("missing cache rates stay unreported; present ones are kept", () => {
		expect(normalizeCost({ input: 3, output: 15 })).toEqual({ input: 3, output: 15 });
		expect(normalizeCost({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
		});
	});
});

describe("chooseModel", () => {
	test("a matched agent file's model wins over the inline one, with its source", () => {
		expect(chooseModel({ model: "p/from-file", path: "/agents/a.md" }, "p/inline")).toEqual({
			requested: "p/from-file",
			sourceFile: "/agents/a.md",
		});
	});
	test("no file model falls through to the inline value", () => {
		expect(chooseModel(undefined, "p/inline")).toEqual({ requested: "p/inline" });
		expect(chooseModel({ path: "/agents/a.md" }, undefined)).toEqual({ requested: undefined });
	});
	test("a blank file model does not override the inline value", () => {
		expect(chooseModel({ model: "  ", path: "/agents/a.md" }, "p/inline")).toEqual({ requested: "p/inline" });
		expect(chooseModel({ model: " p/file ", path: "/agents/a.md" }, undefined)?.requested).toBe("p/file");
	});
});

describe("listSelectableModels", () => {
	const a = fixture({ provider: "p", id: "a" });
	const b = fixture({ provider: "p", id: "b", reasoning: true, contextWindow: 200_000 });
	const c = fixture({ provider: "q", id: "c" });

	test("session scope lists exactly the scoped models and says so", () => {
		const catalog = listSelectableModels(ctxFor([a, b, c], [c, a]), { prefer: [], hide: [], path: "f" });
		expect(catalog.scope).toBe("session");
		expect(catalog.models.map((m) => m.reference)).toEqual(["q/c", "p/a"]);
	});

	test("no configured scope falls back to the available catalogue with the explicit source", () => {
		const catalog = listSelectableModels(ctxFor([a, b]), { prefer: [], hide: [], path: "f" });
		expect(catalog.scope).toBe("all");
		expect(catalog.models.map((m) => m.reference)).toEqual(["p/a", "p/b"]);
		const text = renderModelCatalog(catalog).content[0]!.text;
		expect(text).toContain("no model scoping");
		expect(text).toContain("usable credentials");
	});

	test("every listed reference round-trips through the real resolver", () => {
		const ctx = ctxFor([a, b, c], [a, b, c]);
		const catalog = listSelectableModels(ctx, { prefer: [], hide: [], path: "f" });
		expect(catalog.models).toHaveLength(3);
		for (const entry of catalog.models) {
			const resolved = resolveChildModel(ctx, entry.reference);
			expect(resolved?.provider).toBe(entry.provider);
			expect(resolved?.id).toBe(entry.id);
		}
	});

	test("a reference another model's bare id would shadow is reported ambiguous, not listed", () => {
		const shadow = fixture({ provider: "9router", id: "anthropic/claude-x" });
		const real = fixture({ provider: "anthropic", id: "claude-x" });
		const catalog = listSelectableModels(ctxFor([shadow, real]), { prefer: [], hide: [], path: "f" });
		expect(catalog.models.map((m) => m.reference)).toEqual(["9router/anthropic/claude-x"]);
		expect(catalog.ambiguous).toEqual(["anthropic/claude-x"]);
		const text = renderModelCatalog(catalog).content[0]!.text;
		expect(text).toContain("Do not pass these references");
	});

	test("a registry that cannot resolve an entry is reported as a fault, not a collision", () => {
		const broken = fixture({ provider: "ghost", id: "missing" });
		const ctx = {
			cwd: "/tmp",
			hasUI: false,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [broken] as never[], find: () => undefined },
		} as never as ExtensionContext;
		const catalog = listSelectableModels(ctx, { prefer: [], hide: [], path: "f" });
		expect(catalog.models).toHaveLength(0);
		expect(catalog.unresolved?.[0]).toContain("ghost/missing");
		expect(catalog.unresolved?.[0]).toContain("Model not found");
		expect(catalog.ambiguous).toBeUndefined();
		expect(catalog.unavailable).toContain("could not resolve");
		expect(() => renderModelCatalog(catalog)).toThrow(/No models can be listed/);
	});

	test("missing metadata is normalized: name falls back to id, context to 0, cost to unavailable", () => {
		const catalog = listSelectableModels(ctxFor([{ provider: "p", id: "bare" }]), { prefer: [], hide: [], path: "f" });
		const entry = catalog.models[0]!;
		expect(entry.name).toBe("bare");
		expect(entry.contextWindow).toBe(0);
		expect(entry.cost).toBeUndefined();
		const text = renderModelCatalog(catalog).content[0]!.text;
		expect(text).toContain("context window unreported");
		expect(text).toContain("price: unavailable");
	});

	test("a zero-cost model reads free, a priced model shows its rates", () => {
		const free = fixture({ provider: "local", id: "tiny", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		const paid = fixture({
			provider: "openai",
			id: "big",
			reasoning: true,
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		});
		const text = renderModelCatalog(listSelectableModels(ctxFor([free, paid]), { prefer: [], hide: [], path: "f" }))
			.content[0]!.text;
		expect(text).toContain("price: free");
		expect(text).toContain("in $10.00, out $50.00, cache-read $1.00, cache-write $12.50 per Mtok");
		expect(text).toContain("not a billing quote");
	});

	test("a non-reasoning model says thinking is unsupported; a reasoning one lists levels", () => {
		const text = renderModelCatalog(listSelectableModels(ctxFor([a, b]), { prefer: [], hide: [], path: "f" }))
			.content[0]!.text;
		expect(text).toContain('thinking: not supported — omit it or pass "off"');
		expect(text).toContain("thinking levels: off | minimal | low | medium | high");
	});

	test("preferences reorder and hide without removing permission", () => {
		const prefs: ModelPreferences = {
			prefer: ["q/*"],
			hide: ["p/a"],
			default: "q/c",
			path: "/tmp/subagent-models.json",
		};
		const ctx = ctxFor([a, b, c]);
		const catalog = listSelectableModels(ctx, prefs);
		expect(catalog.models.map((m) => m.reference)).toEqual(["q/c", "p/b"]);
		expect(catalog.hidden).toBe(1);
		expect(catalog.preferredDefault).toBe("q/c");
		expect(catalog.unusedPatterns).toBeUndefined();
		// soft by design: a hidden model is still usable when named.
		expect(resolveChildModel(ctx, "p/a")?.id).toBe("a");
		const text = renderModelCatalog(catalog).content[0]!.text;
		expect(text).toContain("1 enabled model(s) are hidden");
		expect(text).toContain('suggests `model: "q/c"`');
	});

	test("inert valid patterns are reported", () => {
		const prefs: ModelPreferences = { prefer: ["nope/*"], hide: ["gone"], path: "/tmp/subagent-models.json" };
		const catalog = listSelectableModels(ctxFor([a]), prefs);
		expect(catalog.unusedPatterns).toEqual(["gone", "nope/*"]);
		expect(catalog.configError).toBeUndefined();
		expect(renderModelCatalog(catalog).content[0]!.text).toContain("matched no listed model");
	});

	test("unusable config is skipped and reported", () => {
		const prefs: ModelPreferences = {
			prefer: ["nope/*"],
			hide: ["*"],
			path: "/tmp/subagent-models.json",
			error: "unknown key(s): whatever",
		};
		const catalog = listSelectableModels(ctxFor([a]), prefs);
		expect(catalog.models).toHaveLength(1);
		expect(catalog.unusedPatterns).toBeUndefined();
		expect(catalog.configError).toContain("unknown key(s)");
		expect(renderModelCatalog(catalog).content[0]!.text).toContain("WARNING");
	});

	test("duplicate scoped entries are listed once", () => {
		const catalog = listSelectableModels(ctxFor([a], [a, a]), { prefer: [], hide: [], path: "f" });
		expect(catalog.models.map((m) => m.reference)).toEqual(["p/a"]);
	});

	test("a registry failure and a missing registry both surface as unavailable", () => {
		const broken = {
			cwd: "/tmp",
			hasUI: false,
			scopedModels: [],
			modelRegistry: {
				getAvailable: () => {
					throw new Error("registry exploded");
				},
				find: () => undefined,
			},
		} as never as ExtensionContext;
		const catalog = listSelectableModels(broken, { prefer: [], hide: [], path: "f" });
		expect(catalog.unavailable).toContain("registry exploded");
		expect(() => renderModelCatalog(catalog)).toThrow(/No models can be listed/);

		const noRegistry = listSelectableModels({ cwd: "/tmp", hasUI: false } as never as ExtensionContext, {
			prefer: [],
			hide: [],
			path: "f",
		});
		expect(noRegistry.unavailable).toContain("no model registry");
	});
});

describe("extension registration", () => {
	interface CapturedTool {
		name: string;
		description?: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters?: unknown;
		execute: (...args: unknown[]) => Promise<{ content: { type: string; text?: string }[]; details?: unknown }>;
	}
	function fakePi(): { pi: ExtensionAPI; tools: Map<string, CapturedTool> } {
		const tools = new Map<string, CapturedTool>();
		const pi = {
			registerTool: (def: CapturedTool) => tools.set(def.name, def),
			registerCommand: () => {},
			registerShortcut: () => {},
			on: () => () => {},
			events: { emit: () => {} },
			sendUserMessage: () => {},
		} as unknown as ExtensionAPI;
		return { pi, tools };
	}
	function loaded() {
		const { pi, tools } = fakePi();
		extension(pi);
		return tools;
	}
	const execute = (tool: CapturedTool, ctx: ExtensionContext) => tool.execute("call", {}, undefined, undefined, ctx);

	test("registers subagent_models next to the eight existing tools", () => {
		const tools = loaded();
		expect([...tools.keys()]).toEqual([
			"subagent_models",
			"subagent",
			"subagent_status",
			"subagent_result",
			"await_subagent",
			"reply_subagent",
			"steer_subagent",
			"resume_subagent",
			"subagent_cancel",
		]);
		const models = tools.get("subagent_models")!;
		expect(models.promptSnippet).toContain("subagent task can name");
		expect(models.parameters).toBeDefined();
	});

	test("the registered tool returns the session catalog, and throws when nothing is selectable", async () => {
		const tools = loaded();
		const scoped = [fixture({ provider: "p", id: "a" })];
		const result = await execute(tools.get("subagent_models")!, ctxFor(scoped, scoped));
		expect(result.content[0]!.text).toContain("1 model(s) enabled for this session");
		expect(result.content[0]!.text).toContain('model: "p/a"');
		expect(result.details).toMatchObject({ scope: "session" });

		await expect(
			execute(tools.get("subagent_models")!, { cwd: "/tmp", hasUI: false } as never as ExtensionContext),
		).rejects.toThrow(/No models can be listed/);
	});

	test("the subagent guidance points at subagent_models while keeping model optional", () => {
		const tools = loaded();
		const guidance = tools.get("subagent")!.promptGuidelines?.join("\n") ?? "";
		expect(guidance).toContain("subagent_models");
		expect(guidance).toContain("omit it to inherit");
		expect(guidance).not.toMatch(/must (?:name|set) (?:a )?model/i);
	});

	test("the native-modes doc lists every registered tool", () => {
		const tools = loaded();
		const doc = readFileSync(new URL("../docs/native-modes.md", import.meta.url), "utf8");
		expect(doc).toContain(`${tools.size} registered tools`);
		for (const name of tools.keys()) expect(doc).toContain(`| \`${name}\` |`);
	});
	test("README tool count and table match the registered tools", () => {
		const tools = loaded();
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		expect(readme).toContain(`${tools.size} slim tools total`);
		for (const name of tools.keys()) expect(readme).toContain(`| \`${name}\` |`);
	});
});
