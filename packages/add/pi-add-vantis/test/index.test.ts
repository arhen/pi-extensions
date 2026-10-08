import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	createFakeCtx,
	createFakePi,
	createRefreshContext,
	isolateAgentDir,
	stubFetch,
} from "../../../../test-support/fake-pi.ts";

const { root, agentDir } = isolateAgentDir("pi-vantis");
delete process.env.VANTIS_CARD_API_KEY;
delete process.env.VANTIS_CARD_KEY;
const { default: factory } = await import("../src/index.ts");

let fetchStub: ReturnType<typeof stubFetch> | undefined;
afterEach(() => fetchStub?.restore());
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function load() {
	const pi = createFakePi();
	await factory(pi.api);
	const provider = pi.providers.get("vantis") as ProviderConfig;
	return { pi, provider, refresh: provider.refreshModels! };
}

const catalog = {
	data: [{ id: "deepseek-v4-flash", family: "open" }, { id: "frontier-x", context_window: 400_000 }],
	pricing: [
		{
			model: "deepseek-v4-flash",
			label: "DeepSeek V4 Flash",
			family: "open",
			usd_per_1m_input: 0.25,
			usd_per_1m_output: 1,
			context_window: 1_000_000,
		},
	],
};

describe("registration", () => {
	test("provider, command and ZDR shortcut", async () => {
		const { pi, provider } = await load();
		expect(provider.baseUrl).toBe("https://card.vantis.sh/v1");
		expect(provider.api).toBe("openai-completions");
		expect(provider.apiKey).toBe("$VANTIS_CARD_API_KEY");
		expect(provider.headers).toEqual({ "User-Agent": "pi/1.0" });
		expect([...pi.commands.keys()]).toEqual(["vantis"]);
		expect([...pi.shortcuts.keys()]).toEqual(["ctrl+shift+z"]);
	});
});

describe("refreshModels", () => {
	test("maps catalog; pricing stays USD per 1M tokens (pi's unit); persists the etag", async () => {
		const { refresh } = await load();
		fetchStub = stubFetch(() => Response.json(catalog, { headers: { etag: '"v1"' } }));
		const { context, published } = createRefreshContext();

		const models = (await refresh(context)) as Array<Record<string, any>>;
		expect(models.map((m) => m.id)).toEqual(["deepseek-v4-flash", "frontier-x"]);
		const [open, frontier] = models;
		expect(open).toMatchObject({
			name: "DeepSeek V4 Flash",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 32_768,
			cost: { input: 0.25, output: 1, cacheRead: 0.25, cacheWrite: 0.25 },
			compat: { thinkingFormat: "deepseek" },
		});
		expect(frontier).toMatchObject({ name: "frontier-x", reasoning: false, contextWindow: 400_000 });
		expect((published[0] as { persist: { etag: string } }).persist.etag).toBe('"v1"');
		expect(fetchStub.calls[0]?.headers["user-agent"]).toBe("pi/1.0");
		expect(fetchStub.calls[0]?.headers.authorization).toBeUndefined();
	});

	test("sends the credential and If-None-Match; 304 keeps the stored catalog", async () => {
		const { refresh } = await load();
		fetchStub = stubFetch(() => new Response(null, { status: 304 }));
		const stored = { models: [{ id: "kept" }], etag: '"v1"' } as never;
		const { context } = createRefreshContext({ stored, credential: { type: "api_key", key: "vk-1" } as never });

		const models = await refresh(context);
		expect(models.map((m) => m.id)).toEqual(["kept"]);
		expect(fetchStub.calls[0]?.headers).toMatchObject({ authorization: "Bearer vk-1", "if-none-match": '"v1"' });
	});

	test("offline, network errors and HTTP errors keep the stored catalog", async () => {
		const { refresh } = await load();
		spyOn(console, "error").mockImplementation(() => {});
		const stored = { models: [{ id: "kept" }] } as never;

		fetchStub = stubFetch(() => {
			throw new Error("network down");
		});
		expect((await refresh(createRefreshContext({ stored, allowNetwork: false }).context)).map((m) => m.id)).toEqual([
			"kept",
		]);
		expect(fetchStub.calls).toHaveLength(0);
		expect((await refresh(createRefreshContext({ stored }).context)).map((m) => m.id)).toEqual(["kept"]);
		fetchStub.restore();

		fetchStub = stubFetch(() => new Response("nope", { status: 500 }));
		expect((await refresh(createRefreshContext({ stored }).context)).map((m) => m.id)).toEqual(["kept"]);
	});
});

describe("ZDR", () => {
	test("/vantis zdr on|off persists, re-registers headers and force-refreshes", async () => {
		const { pi } = await load();
		const on = createFakeCtx({ model: { provider: "vantis" } });
		await pi.run("vantis", "zdr on", on.ctx);

		expect(JSON.parse(readFileSync(join(agentDir, "vantis.json"), "utf8")).zdr).toBe(true);
		expect(pi.providers.get("vantis")?.headers).toEqual({ "User-Agent": "pi/1.0", "X-ZDR": "required" });
		expect(on.refreshes).toEqual([{ providers: ["vantis"], force: true }]);
		expect(on.statuses.get("vantis")).toBe("ZDR");
		expect(on.notifications.at(-1)?.type).toBe("warning");

		const off = createFakeCtx({ model: { provider: "vantis" } });
		await pi.run("vantis", "zdr off", off.ctx);
		expect(JSON.parse(readFileSync(join(agentDir, "vantis.json"), "utf8")).zdr).toBe(false);
		expect(pi.providers.get("vantis")?.headers).toEqual({ "User-Agent": "pi/1.0" });
	});

	test("the shortcut refuses to toggle outside vantis models", async () => {
		const { pi } = await load();
		const { ctx, notifications, refreshes } = createFakeCtx({ model: { provider: "openai" } });
		await pi.shortcuts.get("ctrl+shift+z")?.handler(ctx as never);
		expect(refreshes).toEqual([]);
		expect(notifications.at(-1)?.type).toBe("warning");
	});

	test("footer shows attested ZDR and tier only on vantis models", async () => {
		const { pi } = await load();
		const { ctx, statuses } = createFakeCtx({ model: { provider: "vantis" } });
		await pi.run("vantis", "zdr on", ctx);

		await pi.emit("after_provider_response", { headers: { "X-Vantis-ZDR": "honored", "X-Vantis-Tier": "fast" } }, ctx);
		expect(statuses.get("vantis")).toBe("ZDR✓ · fast");

		await pi.emit("model_select", { model: { provider: "openai" } }, ctx);
		expect(statuses.get("vantis")).toBeUndefined();

		await pi.run("vantis", "zdr off", ctx);
	});
});

describe("/vantis", () => {
	test("models lists the registry catalog in a widget", async () => {
		const { pi } = await load();
		const model = { id: "deepseek-v4-flash-fast", reasoning: true, contextWindow: 1_048_576, maxTokens: 32_768 };
		const { ctx, widgets } = createFakeCtx({ registryModels: [model] });
		await pi.run("vantis", "models", ctx);
		expect(widgets.get("vantis-models")).toEqual([
			"Vantis models — ctx / max out / reasoning / family / tier:",
			"deepseek-v4-flash-fast  ctx=1.0M  out=32.8k  reasoning=on  open  tier=fast",
		]);
	});

	test("balance without a key asks to log in and makes no request", async () => {
		const { pi } = await load();
		fetchStub = stubFetch(() => Response.json({}));
		const { ctx, notifications } = createFakeCtx();
		await pi.run("vantis", "balance", ctx);
		expect(fetchStub.calls).toHaveLength(0);
		expect(notifications.at(-1)?.message).toContain("not logged in");
	});
});
