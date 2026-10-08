import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeCtx, createFakePi, isolateAgentDir } from "../../../../test-support/fake-pi.ts";

const API_KEY = "sk-test-0123456789";
const { root, agentDir, cacheDir } = isolateAgentDir("pi-9router");
const configPath = join(agentDir, "9router-config.json");
const discoveryCachePath = join(cacheDir, "9router-discovery-cache.json");

type Mode = "ok" | "auth" | "down";
let mode: Mode = "ok";
let routerModels: Array<Record<string, unknown>> = [];
const authHeaders: Array<string | null> = [];

const server = Bun.serve({
	port: 0,
	fetch(req) {
		if (new URL(req.url).pathname !== "/v1/models") return new Response("not found", { status: 404 });
		authHeaders.push(req.headers.get("authorization"));
		if (mode === "auth") return new Response("invalid api key", { status: 401 });
		if (mode === "down") return new Response("upstream exploded", { status: 502 });
		return Response.json({ object: "list", data: routerModels });
	},
});

process.env.NINE_ROUTER_BASE_URL = `http://127.0.0.1:${server.port}/`;
process.env.NINE_ROUTER_API_KEY = API_KEY;
delete process.env.NINE_ROUTER_ENABLE_REASONING;

const metadata = {
	openai: {
		models: {
			"gpt-4o": {
				id: "gpt-4o",
				limit: { context: 128_000, output: 16_384 },
				modalities: { input: ["text", "image"] },
			},
		},
	},
};
// A fresh models.dev cache keeps the suite offline.
mkdirSync(cacheDir, { recursive: true });
writeFileSync(join(cacheDir, "9router-model-metadata.json"), JSON.stringify({ ts: Date.now(), data: metadata }));

const mod = await import("../src/index.ts");
const factory = mod.default;

afterAll(() => {
	server.stop(true);
	rmSync(root, { recursive: true, force: true });
});

function modelIds(config: { models?: Array<{ id: string }> } | undefined): string[] {
	return (config?.models ?? []).map((m) => m.id);
}

async function until(check: () => boolean, timeoutMs = 2000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
		await Bun.sleep(5);
	}
}

describe("pure helpers", () => {
	test("parseTokenCount accepts numbers and k/m suffixed strings", () => {
		expect(mod.parseTokenCount(128_000)).toBe(128_000);
		expect(mod.parseTokenCount(4096.9)).toBe(4096);
		expect(mod.parseTokenCount("128k")).toBe(128_000);
		expect(mod.parseTokenCount("1.5M")).toBe(1_500_000);
		expect(mod.parseTokenCount(" 1,048,576 ")).toBe(1_048_576);
	});

	test("parseTokenCount rejects junk, zero, negative, non-finite", () => {
		for (const value of ["abc", "12x", "", 0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}]) {
			expect(mod.parseTokenCount(value)).toBeUndefined();
		}
	});

	test("parseBooleanFlag", () => {
		expect(mod.parseBooleanFlag("YES")).toBe(true);
		expect(mod.parseBooleanFlag(" on ")).toBe(true);
		expect(mod.parseBooleanFlag("0")).toBe(false);
		expect(mod.parseBooleanFlag("disabled")).toBe(false);
		expect(mod.parseBooleanFlag("maybe")).toBeUndefined();
		expect(mod.parseBooleanFlag(undefined)).toBeUndefined();
	});

	test("maskApiKey never reveals short keys and keeps 4+4 of long ones", () => {
		expect(mod.maskApiKey("abcd1234")).toBe("●●●●●●●●");
		expect(mod.maskApiKey("sk-abcdef-wxyz")).toBe("sk-a●●●●●●wxyz");
	});

	test("lookupModelMetadata resolves provider prefixes, date and :free suffixes", () => {
		const index = mod.buildModelMetadataIndex(metadata);
		for (const id of ["gpt-4o", "openai/gpt-4o", "cx/openai/gpt-4o", "gpt-4o-20240806", "gpt-4o:free"]) {
			expect(mod.lookupModelMetadata(id, index)?.id).toBe("gpt-4o");
		}
		expect(mod.lookupModelMetadata("claude-sonnet", index)).toBeUndefined();
	});
});

describe("mapNineRouterModel", () => {
	const gpt = metadata.openai.models["gpt-4o"];

	test("router-reported limits win over metadata", () => {
		const mapped = mod.mapNineRouterModel(
			{ id: "gpt-4o", object: "model", context_length: "200k", max_output_tokens: 8192 },
			false,
			gpt,
		);
		expect(mapped.contextWindow).toBe(200_000);
		expect(mapped.maxTokens).toBe(8192);
		expect(mapped.input).toEqual(["text", "image"]);
	});

	test("metadata fills missing limits, then the fallback does", () => {
		const fromMetadata = mod.mapNineRouterModel({ id: "gpt-4o", object: "model" }, false, gpt);
		expect([fromMetadata.contextWindow, fromMetadata.maxTokens]).toEqual([128_000, 16_384]);

		const fallback = mod.mapNineRouterModel({ id: "unknown", object: "model" }, false);
		expect([fallback.contextWindow, fallback.maxTokens]).toEqual([128_000, 4096]);
		expect(fallback.input).toEqual(["text"]);
	});

	test("nested limit paths are read", () => {
		const mapped = mod.mapNineRouterModel(
			{ id: "x", object: "model", top_provider: { context_length: 64_000, max_completion_tokens: 2000 } },
			false,
		);
		expect([mapped.contextWindow, mapped.maxTokens]).toEqual([64_000, 2000]);
	});

	test("max tokens never exceed the context window; MiMo is capped", () => {
		const tiny = mod.mapNineRouterModel({ id: "x", object: "model", context_length: 1000, max_tokens: 5000 }, false);
		expect(tiny.maxTokens).toBe(1000);

		const mimo = mod.mapNineRouterModel(
			{ id: "xiaomi/MiMo-V2", object: "model", context_length: 1_000_000, max_tokens: 1_000_000 },
			false,
		);
		expect(mimo.maxTokens).toBe(131_072);
	});

	test("combos are labelled; reasoning adds the thinking map and effort compat", () => {
		const off = mod.mapNineRouterModel({ id: "best", object: "model", owned_by: "combo" }, false);
		expect(off.name).toBe("🔀 best");
		expect(off.reasoning).toBe(false);
		expect("thinkingLevelMap" in off).toBe(false);
		expect(off.compat.supportsReasoningEffort).toBe(false);

		const on = mod.mapNineRouterModel({ id: "best", object: "model", owned_by: "combo" }, true);
		expect(on.reasoning).toBe(true);
		expect(on.thinkingLevelMap?.high).toBe("high");
		expect(on.thinkingLevelMap?.off).toBe("none");
		expect(on.compat.supportsReasoningEffort).toBe(true);
	});

	test("limit summary reports sources", () => {
		expect(mod.modelLimitSummary({ id: "gpt-4o", object: "model" }, gpt)).toBe(
			"128k ctx / 16384 out (metadata/metadata)",
		);
	});
});

describe("extension lifecycle", () => {
	beforeEach(() => {
		mode = "ok";
		routerModels = [
			{ id: "openai/gpt-4o", object: "model", owned_by: "openai" },
			{ id: "best", object: "model", owned_by: "combo" },
		];
		authHeaders.length = 0;
		spyOn(console, "warn").mockImplementation(() => {});
		rmSync(discoveryCachePath, { force: true });
		rmSync(configPath, { force: true });
	});

	test("cold start discovers models and registers the provider", async () => {
		const pi = createFakePi();
		await factory(pi.api);

		const provider = pi.providers.get("9router");
		expect(provider?.baseUrl).toBe(`http://127.0.0.1:${server.port}/v1`);
		expect(provider?.apiKey).toBe(API_KEY);
		expect(provider?.api).toBe("openai-completions");
		expect(modelIds(provider)).toEqual(["openai/gpt-4o", "best"]);
		expect((provider?.models?.[0] as { contextWindow?: number } | undefined)?.contextWindow).toBe(128_000);
		expect(authHeaders).toEqual([`Bearer ${API_KEY}`]);
		expect([...pi.commands.keys()].sort()).toEqual([
			"9router-config",
			"9router-models",
			"9router-reasoning",
			"9router-reload",
			"9router-status",
		]);
	});

	test("discovery cache stores a key fingerprint, never the key, with 0600 perms", async () => {
		await factory(createFakePi().api);

		const raw = readFileSync(discoveryCachePath, "utf8");
		expect(raw).not.toContain(API_KEY);
		expect(JSON.parse(raw).apiKeyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(statSync(discoveryCachePath).mode & 0o777).toBe(0o600);
	});

	test("warm start registers cached models first, then refreshes in the background", async () => {
		await factory(createFakePi().api);
		routerModels = [{ id: "fresh-model", object: "model" }];

		const pi = createFakePi();
		await factory(pi.api);
		expect(modelIds(pi.registrations[0]?.config)).toEqual(["openai/gpt-4o", "best"]);

		await until(() => pi.registrations.length === 2);
		expect(modelIds(pi.providers.get("9router"))).toEqual(["fresh-model"]);
	});

	test("a cache written for another key is ignored", async () => {
		await factory(createFakePi().api);
		const cache = JSON.parse(readFileSync(discoveryCachePath, "utf8"));
		writeFileSync(discoveryCachePath, JSON.stringify({ ...cache, apiKeyHash: "sha256:other" }));
		routerModels = [{ id: "live-only", object: "model" }];

		const pi = createFakePi();
		await factory(pi.api);
		expect(pi.registrations.map((r) => modelIds(r.config))).toEqual([["live-only"]]);
	});

	test("auth failure on reload unregisters the provider and clears the cache", async () => {
		const pi = createFakePi();
		await factory(pi.api);
		expect(existsSync(discoveryCachePath)).toBe(true);

		mode = "auth";
		const { ctx, notifications } = createFakeCtx();
		await pi.run("9router-reload", "", ctx);

		expect(pi.providers.has("9router")).toBe(false);
		expect(existsSync(discoveryCachePath)).toBe(false);
		expect(notifications.at(-1)?.type).toBe("warning");
		expect(notifications.at(-1)?.message).toContain("not configured");
	});

	test("transient failure on reload keeps the working provider", async () => {
		const pi = createFakePi();
		await factory(pi.api);

		mode = "down";
		const { ctx, notifications } = createFakeCtx();
		await pi.run("9router-reload", "", ctx);

		expect(modelIds(pi.providers.get("9router"))).toEqual(["openai/gpt-4o", "best"]);
		expect(pi.unregistered).toEqual([]);
		expect(notifications.at(-1)?.type).toBe("error");
		expect(notifications.at(-1)?.message).toContain("disconnected");
	});

	test("cold start with the router down registers nothing and reports on session start", async () => {
		mode = "down";
		const pi = createFakePi();
		await factory(pi.api);
		expect(pi.providers.has("9router")).toBe(false);

		const { ctx, notifications } = createFakeCtx();
		await pi.emit("session_start", {}, ctx);
		expect(notifications.at(-1)?.message).toContain("disconnected");
	});

	test("session start announces the model count when connected", async () => {
		const pi = createFakePi();
		await factory(pi.api);
		const { ctx, notifications } = createFakeCtx();
		await pi.emit("session_start", {}, ctx);
		expect(notifications).toEqual([{ message: "9router connected — 2 models available", type: "info" }]);
	});

	test("/9router-reasoning re-registers with thinking levels and persists the choice", async () => {
		const pi = createFakePi();
		await factory(pi.api);
		const { ctx } = createFakeCtx({ select: ["Enable reasoning"] });
		await pi.run("9router-reasoning", "", ctx);

		const models = pi.providers.get("9router")?.models ?? [];
		expect(models.every((m) => "reasoning" in m && m.reasoning)).toBe(true);
		expect(JSON.parse(readFileSync(configPath, "utf8")).enableReasoning).toBe(true);
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		expect(pi.entries.at(-1)?.customType).toBe("9router-config");
	});

	test("/9router-models switches to the picked model", async () => {
		const pi = createFakePi();
		await factory(pi.api);
		const label = "🔀 best (128k ctx / 4096 out (fallback/fallback))";
		const { ctx } = createFakeCtx({ select: [label] });
		await pi.run("9router-models", "", ctx);
		expect(pi.userMessages).toEqual(["/model 9router/best"]);
	});
});
