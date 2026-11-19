import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createHarness, plain } from "./harness.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senja-speed-"));
	process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
	if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = agentDir;
	rmSync(dir, { recursive: true, force: true });
});

function openaiHarness() {
	const h = createHarness();
	h.ctx.model = {
		provider: "openai",
		id: "gpt-6.2-sol",
		reasoning: true,
		contextWindow: 272_000,
	} as unknown as typeof h.ctx.model;
	return h;
}

async function setTier(h: ReturnType<typeof createHarness>, command: string, arg: string) {
	await h.commands.get(command)!.handler(arg, h.ctx as ExtensionCommandContext);
}

function footerLine1(h: ReturnType<typeof createHarness>): string {
	return plain(h.footer!.render(400)[0]!);
}

describe("speed tier", () => {
	test("off by default: state file absent, payloads untouched, no footer chip", async () => {
		const h = openaiHarness();
		await h.emit("session_start", { reason: "startup" });
		const payload = { model: "gpt-6.2-sol", input: [] };
		const result = await h.emitProviderRequest(payload);
		expect(result).toBe(payload);
		expect(existsSync(join(dir, "fast-mode"))).toBe(false);
		expect(footerLine1(h)).not.toContain("fast");
	});

	test("/fast on injects service_tier priority, persists, and shows a footer chip", async () => {
		const h = openaiHarness();
		await h.emit("session_start", { reason: "startup" });
		await setTier(h, "fast", "on");
		const result = (await h.emitProviderRequest({ model: "gpt-6.2-sol", input: [] })) as Record<string, unknown>;
		expect(result.service_tier).toBe("priority");
		expect(footerLine1(h)).toContain("▪ fast");
	});

	test("/ultrafast on replaces fast; /fast off leaves ultrafast active", async () => {
		const h = openaiHarness();
		await h.emit("session_start", { reason: "startup" });
		await setTier(h, "fast", "on");
		await setTier(h, "ultrafast", "on");
		const result = (await h.emitProviderRequest({ model: "gpt-6.2-sol" })) as Record<string, unknown>;
		expect(result.service_tier).toBe("ultrafast");
		expect(footerLine1(h)).toContain("▪ ultrafast");
		await setTier(h, "fast", "off");
		expect(footerLine1(h)).toContain("▪ ultrafast");
	});

	test("/ultrafast off clears the tier and stops injecting", async () => {
		const h = openaiHarness();
		await h.emit("session_start", { reason: "startup" });
		await setTier(h, "ultrafast", "on");
		await setTier(h, "ultrafast", "off");
		const payload = { model: "gpt-6.2-sol" };
		expect(await h.emitProviderRequest(payload)).toBe(payload);
		expect(footerLine1(h)).not.toContain("fast");
	});

	test("injection is gated: other providers, model mismatch, and explicit service_tier are untouched", async () => {
		const h = openaiHarness();
		await h.emit("session_start", { reason: "startup" });
		await setTier(h, "fast", "on");

		const otherProvider = createHarness();
		await otherProvider.emit("session_start", { reason: "startup" });
		await otherProvider.commands.get("fast")!.handler("on", otherProvider.ctx as ExtensionCommandContext);
		const anthropicPayload = { model: "claude-test" };
		expect(await otherProvider.emitProviderRequest(anthropicPayload)).toBe(anthropicPayload);

		const mismatch = { model: "gpt-5.6-luna", input: [] };
		expect(await h.emitProviderRequest(mismatch)).toBe(mismatch);

		const preset = { model: "gpt-6.2-sol", service_tier: "flex" };
		expect(await h.emitProviderRequest(preset)).toBe(preset);
	});

	test("switching models restores each badge and request tier without inheriting the old global setting", async () => {
		writeFileSync(join(dir, "fast-mode.json"), JSON.stringify({ tier: "fast" }));
		const h = openaiHarness();
		await h.emit("session_start", { reason: "startup" });
		async function select(provider: string, id: string, tier?: "fast" | "ultrafast") {
			h.ctx.model = { ...h.ctx.model!, provider, id };
			await h.emit("model_select", { model: h.ctx.model });
			expect(footerLine1(h)).toEndWith(`${provider} ▪ ${id} ▪ high${tier ? ` ▪ ${tier}` : ""}`);
			const payload = await h.emitProviderRequest({ model: id });
			expect(payload).toEqual(tier ? { model: id, service_tier: tier === "fast" ? "priority" : tier } : { model: id });
			await setTier(h, "fast", "");
			expect(h.ui.notify).toHaveBeenLastCalledWith(tier ? `${tier} mode is on` : "Fast and Ultrafast are off", "info");
		}
		await select("openai", "gpt-6.2-sol");
		await setTier(h, "fast", "on");
		await select("openai", "gpt-6.2-astra");
		await setTier(h, "ultrafast", "on");
		await select("openai-codex", "gpt-6.2-sol");
		await select("claude-code", "claude-opus-5");
		await select("openai", "gpt-6.2-sol", "fast");
		await setTier(h, "fast", "off");
		await select("openai", "gpt-6.2-astra", "ultrafast");
		await select("openai", "gpt-6.2-sol");
	});

	test("persisted tier loads into a fresh instance and injects without toggling", async () => {
		const first = openaiHarness();
		await first.emit("session_start", { reason: "startup" });
		await setTier(first, "ultrafast", "on");

		const second = openaiHarness();
		await second.emit("session_start", { reason: "startup" });
		const result = (await second.emitProviderRequest({ model: "gpt-6.2-sol" })) as Record<string, unknown>;
		expect(result.service_tier).toBe("ultrafast");
	});

	test("setting on a known model reports info; the tier is sent", async () => {
		const h = openaiHarness();
		await h.emit("session_start", { reason: "startup" });
		await setTier(h, "fast", "on");
		expect(h.ui.notify).toHaveBeenCalledWith("fast mode on — service_tier: priority", "info");
		await setTier(h, "ultrafast", "on");
		expect(h.ui.notify).toHaveBeenCalledWith("ultrafast mode on — service_tier: ultrafast", "info");
	});

	test("setting on a non-OpenAI model warns that the tier only affects OpenAI requests", async () => {
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		await setTier(h, "fast", "on");
		expect(h.ui.notify).toHaveBeenCalledWith("Speed tiers require an OpenAI model", "warning");
		expect(footerLine1(h)).not.toContain("fast");
		expect(existsSync(join(dir, "fast-mode"))).toBe(false);
	});

	test("setting on an OpenAI model outside the known list warns", async () => {
		const h = openaiHarness();
		h.ctx.model = { ...h.ctx.model, id: "gpt-4o" } as typeof h.ctx.model;
		await h.emit("session_start", { reason: "startup" });
		await setTier(h, "fast", "on");
		expect(h.ui.notify).toHaveBeenCalledWith(
			"fast mode on — gpt-4o is not on the known fast support list; OpenAI may reject or ignore the request",
			"warning",
		);
	});

	test("ultrafast on a fast-only model warns", async () => {
		const h = openaiHarness();
		h.ctx.model = { ...h.ctx.model, id: "gpt-5.6-sol" } as typeof h.ctx.model;
		await h.emit("session_start", { reason: "startup" });
		await setTier(h, "ultrafast", "on");
		expect(h.ui.notify).toHaveBeenCalledWith(
			"ultrafast mode on — gpt-5.6-sol is not on the known ultrafast support list; OpenAI may reject or ignore the request",
			"warning",
		);
	});

	test("bare /fast reports state without changing it", async () => {
		const h = openaiHarness();
		await h.emit("session_start", { reason: "startup" });
		await setTier(h, "fast", "");
		expect(existsSync(join(dir, "fast-mode"))).toBe(false);
		expect(h.ui.notify).toHaveBeenCalledWith("Fast and Ultrafast are off", "info");
		await setTier(h, "ultrafast", "on");
		await setTier(h, "fast", "");
		expect(h.ui.notify).toHaveBeenCalledWith("ultrafast mode is on", "info");
	});
});
