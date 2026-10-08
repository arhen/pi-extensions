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

const { root, agentDir } = isolateAgentDir("pi-wafer");
delete process.env.WAFER_API_KEY;
const { default: factory } = await import("../src/index.ts");

let fetchStub: ReturnType<typeof stubFetch> | undefined;
afterEach(() => {
	fetchStub?.restore();
	delete process.env.WAFER_API_KEY;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function load() {
	const pi = createFakePi();
	await factory(pi.api);
	const provider = pi.providers.get("wafer") as ProviderConfig;
	return { pi, provider, refresh: provider.refreshModels! };
}

const catalog = {
	data: [
		{
			id: "glm-5",
			zdr_supported: true,
			max_model_len: 202_752,
			wafer: {
				display_name: "GLM 5",
				max_output_tokens: 65_536,
				capabilities: { reasoning: true, vision: true },
				pricing: { input_cents_per_million: 60, output_cents_per_million: 220, cache_read_cents_per_million: 11 },
			},
		},
		{ id: "plain", zdr_supported: false },
	],
};

describe("registration", () => {
	test("provider and command", async () => {
		const { pi, provider } = await load();
		expect(provider.baseUrl).toBe("https://pass.wafer.ai/v1");
		expect(provider.api).toBe("openai-completions");
		expect(provider.apiKey).toBe("$WAFER_API_KEY");
		expect(provider.headers).toBeUndefined();
		expect([...pi.commands.keys()]).toEqual(["wafer"]);
	});
});

describe("refreshModels", () => {
	test("no key: stays offline and returns the stored catalog", async () => {
		const { refresh } = await load();
		fetchStub = stubFetch(() => Response.json(catalog));
		const models = await refresh(createRefreshContext({ stored: { models: [{ id: "kept" }] } as never }).context);
		expect(models.map((m) => m.id)).toEqual(["kept"]);
		expect(fetchStub.calls).toHaveLength(0);
	});

	test("maps cards: cents → dollars, vision, reasoning, limits and defaults", async () => {
		const { refresh } = await load();
		fetchStub = stubFetch(() => Response.json(catalog, { headers: { etag: '"w1"' } }));
		const { context, published } = createRefreshContext({ credential: { type: "api_key", key: "wk-1" } as never });

		const [glm, plain] = (await refresh(context)) as Array<Record<string, any>>;
		expect(glm).toMatchObject({
			name: "GLM 5",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 202_752,
			maxTokens: 65_536,
			cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
		});
		expect(plain).toMatchObject({ name: "plain", reasoning: false, input: ["text"], contextWindow: 200_000 });
		expect(plain?.maxTokens).toBe(32_768);
		expect(fetchStub.calls[0]?.headers.authorization).toBe("Bearer wk-1");
		expect((published[0] as { persist: { etag: string } }).persist.etag).toBe('"w1"');
	});

	test("HTTP errors keep the stored catalog", async () => {
		const { refresh } = await load();
		spyOn(console, "error").mockImplementation(() => {});
		process.env.WAFER_API_KEY = "wk-env";
		fetchStub = stubFetch(() => new Response("bad", { status: 503 }));
		const models = await refresh(createRefreshContext({ stored: { models: [{ id: "kept" }] } as never }).context);
		expect(models.map((m) => m.id)).toEqual(["kept"]);
		expect(fetchStub.calls[0]?.headers.authorization).toBe("Bearer wk-env");
	});
});

describe("ZDR", () => {
	test("/wafer zdr on adds the header, persists and hides non-ZDR models", async () => {
		const { pi } = await load();
		const { ctx, refreshes, statuses } = createFakeCtx();
		await pi.run("wafer", "zdr on", ctx);

		expect(JSON.parse(readFileSync(join(agentDir, "wafer.json"), "utf8")).zdr).toBe(true);
		const provider = pi.providers.get("wafer") as ProviderConfig;
		expect(provider.headers).toEqual({ "Wafer-ZDR": "required" });
		expect(refreshes).toEqual([{ providers: ["wafer"], force: true }]);
		expect(statuses.get("wafer")).toBe("ZDR");

		fetchStub = stubFetch(() => Response.json(catalog));
		const models = await provider.refreshModels!(
			createRefreshContext({ credential: { type: "api_key", key: "wk-1" } as never }).context,
		);
		expect(models.map((m) => m.id)).toEqual(["glm-5"]);

		await pi.run("wafer", "zdr off", ctx);
		expect(pi.providers.get("wafer")?.headers).toBeUndefined();
	});
});

describe("/wafer", () => {
	test("usage without a key asks to log in and makes no request", async () => {
		const { pi } = await load();
		fetchStub = stubFetch(() => Response.json({}));
		const { ctx, notifications } = createFakeCtx();
		await pi.run("wafer", "usage", ctx);
		expect(fetchStub.calls).toHaveLength(0);
		expect(notifications.at(-1)?.message).toContain("not logged in");
	});

	test("usage reports 24h totals and cache hit rate", async () => {
		const { pi } = await load();
		process.env.WAFER_API_KEY = "wk-env";
		fetchStub = stubFetch(({ url }) =>
			url.includes("/usage/me")
				? Response.json({
						total_input_tokens: 1_500_000,
						total_output_tokens: 2_000,
						total_cache_read_tokens: 900,
						total_requests: 42,
						total_estimated_cost_cents: 123,
					})
				: Response.json({ summary: { cache_hit_pct: 87.25 } }),
		);
		const { ctx, notifications } = createFakeCtx();
		await pi.run("wafer", "usage", ctx);
		expect(fetchStub.calls.map((c) => new URL(c.url).pathname).sort()).toEqual([
			"/v1/endpoints/metrics",
			"/v1/usage/me",
		]);
		expect(notifications.at(-1)?.message).toBe("Wafer 24h: ↑1.5M ↓2.0k R900 · 42 req · ≈$1.23 · cache hit 87.3% (24h)");
	});
});
