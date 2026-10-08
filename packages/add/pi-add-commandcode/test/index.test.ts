import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	createFakeCtx,
	createFakePi,
	createRefreshContext,
	isolateAgentDir,
	stubFetch,
} from "../../../../test-support/fake-pi.ts";

const { root, agentDir } = isolateAgentDir("pi-commandcode");
delete process.env.COMMANDCODE_API_KEY;
const { default: factory } = await import("../src/index.ts");

const claude = getModels("anthropic")[0]!;
const liveCards = [
	{ id: claude.id, name: "Claude", context_length: 1_000_000 },
	{ id: "gpt-5.5", name: "GPT-5.5", context_length: 400_000 },
	{ id: "brand-new-model" },
];

let fetchStub: ReturnType<typeof stubFetch> | undefined;
afterEach(() => fetchStub?.restore());
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function load(respond: Parameters<typeof stubFetch>[0] = () => Response.json({ data: liveCards })) {
	fetchStub = stubFetch(respond);
	const pi = createFakePi();
	await factory(pi.api);
	const provider = pi.providers.get("commandcode") as ProviderConfig;
	return { pi, provider, refresh: provider.refreshModels! };
}

type Mapped = Record<string, any>;

describe("factory", () => {
	test("fetches the catalog before startup and routes Claude ids to /messages", async () => {
		const { provider } = await load();
		expect(fetchStub?.calls[0]?.url).toBe("https://api.commandcode.ai/provider/v1/models");
		expect(provider.apiKey).toBe("$COMMANDCODE_API_KEY");
		expect(provider.headers).toBeUndefined();

		const [c, gpt, unknown] = provider.models as unknown as Mapped[];
		expect(c).toMatchObject({
			id: claude.id,
			provider: "commandcode",
			api: "anthropic-messages",
			baseUrl: "https://api.commandcode.ai/provider",
			contextWindow: 1_000_000,
			cost: claude.cost,
		});
		expect(gpt).toMatchObject({
			name: "GPT-5.5",
			api: "openai-completions",
			baseUrl: "https://api.commandcode.ai/provider/v1",
			contextWindow: 400_000,
			maxTokens: 32_768,
		});
		expect(gpt?.cost.input).toBeGreaterThan(0);
		expect(unknown).toMatchObject({ name: "brand-new-model", reasoning: true, contextWindow: 200_000 });
		expect(unknown?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("offline startup omits `models` so the last-known catalog survives", async () => {
		const { provider } = await load(() => {
			throw new Error("offline");
		});
		expect("models" in provider).toBe(false);
	});
});

describe("refreshModels", () => {
	test("falls back to the factory catalog when nothing is stored yet", async () => {
		const { refresh } = await load();
		const offline = await refresh(createRefreshContext({ allowNetwork: false }).context);
		expect(offline.map((m) => m.id)).toEqual(liveCards.map((c) => c.id));

		spyOn(console, "error").mockImplementation(() => {});
		fetchStub?.restore();
		fetchStub = stubFetch(() => new Response("down", { status: 503 }));
		const failed = await refresh(createRefreshContext().context);
		expect(failed.map((m) => m.id)).toEqual(liveCards.map((c) => c.id));
	});

	test("304 republishes the stored catalog; 200 publishes the new one with its etag", async () => {
		const { refresh } = await load();
		const stored = { models: [{ id: "stored" }], etag: '"c1"' } as never;

		fetchStub?.restore();
		fetchStub = stubFetch(() => new Response(null, { status: 304 }));
		const notModified = createRefreshContext({ stored });
		expect((await refresh(notModified.context)).map((m) => m.id)).toEqual(["stored"]);
		expect(fetchStub.calls[0]?.headers["if-none-match"]).toBe('"c1"');
		expect(notModified.published).toEqual([{ persist: stored }]);

		fetchStub.restore();
		fetchStub = stubFetch(() => Response.json({ data: [{ id: "gpt-5.5" }] }, { headers: { etag: '"c2"' } }));
		const fresh = createRefreshContext({ stored });
		expect((await refresh(fresh.context)).map((m) => m.id)).toEqual(["gpt-5.5"]);
		expect((fresh.published[0] as { persist: { etag: string } }).persist.etag).toBe('"c2"');
	});
});

describe("/commandcode zdr", () => {
	test("on: header, persisted state, footer on commandcode models; off restores", async () => {
		const { pi } = await load();
		const { ctx, statuses, notifications } = createFakeCtx({ model: { provider: "commandcode" } });

		await pi.run("commandcode", "zdr on", ctx);
		expect(pi.providers.get("commandcode")?.headers).toEqual({ "x-cmd-zdr": "1" });
		expect(JSON.parse(readFileSync(join(agentDir, "commandcode.json"), "utf8"))).toEqual({ zdr: true });
		expect(statuses.get("commandcode")).toBe("ZDR");
		expect(notifications.at(-1)?.type).toBe("warning");

		await pi.emit("model_select", { model: { provider: "openai" } }, ctx);
		expect(statuses.get("commandcode")).toBeUndefined();

		await pi.run("commandcode", "zdr off", ctx);
		expect(pi.providers.get("commandcode")?.headers).toBeUndefined();
	});

	test("argument completions", async () => {
		const { pi } = await load();
		const complete = pi.commands.get("commandcode")?.getArgumentCompletions;
		expect(await complete?.("zdr o")).toEqual([
			{ value: "zdr on", label: "zdr on" },
			{ value: "zdr off", label: "zdr off" },
		]);
		expect(await complete?.("x")).toBeNull();
	});
});
