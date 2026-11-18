import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createHarness, plain } from "./harness.ts";

const stateFile = () => join(process.env.PI_CODING_AGENT_DIR ?? "", "fast-mode.json");

beforeEach(() => {
	rmSync(stateFile(), { force: true });
});

afterEach(() => {
	rmSync(stateFile(), { force: true });
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
		expect(existsSync(stateFile())).toBe(false);
		expect(footerLine1(h)).not.toContain("fast");
	});

	test("/fast on injects service_tier priority, persists, and shows a footer chip", async () => {
		const h = openaiHarness();
		await h.emit("session_start", { reason: "startup" });
		await setTier(h, "fast", "on");
		expect(JSON.parse(readFileSync(stateFile(), "utf8"))).toEqual({ tier: "fast" });
		const result = (await h.emitProviderRequest({ model: "gpt-6.2-sol", input: [] })) as Record<string, unknown>;
		expect(result.service_tier).toBe("priority");
		expect(footerLine1(h)).toContain("▪ fast");
	});

	test("/ultrafast on replaces fast; /fast off leaves ultrafast active", async () => {
		const h = openaiHarness();
		await h.emit("session_start", { reason: "startup" });
		await setTier(h, "fast", "on");
		await setTier(h, "ultrafast", "on");
		expect(JSON.parse(readFileSync(stateFile(), "utf8"))).toEqual({ tier: "ultrafast" });
		const result = (await h.emitProviderRequest({ model: "gpt-6.2-sol" })) as Record<string, unknown>;
		expect(result.service_tier).toBe("ultrafast");
		expect(footerLine1(h)).toContain("▪ ultrafast");
		await setTier(h, "fast", "off");
		expect(JSON.parse(readFileSync(stateFile(), "utf8"))).toEqual({ tier: "ultrafast" });
	});

	test("/ultrafast off clears the tier and stops injecting", async () => {
		const h = openaiHarness();
		await h.emit("session_start", { reason: "startup" });
		await setTier(h, "ultrafast", "on");
		await setTier(h, "ultrafast", "off");
		expect(JSON.parse(readFileSync(stateFile(), "utf8"))).toEqual({ tier: null });
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
		expect(h.ui.notify).toHaveBeenCalledWith(
			"fast mode on — it only affects OpenAI requests; active model is anthropic/claude-test",
			"warning",
		);
		expect(JSON.parse(readFileSync(stateFile(), "utf8"))).toEqual({ tier: "fast" });
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
		expect(JSON.parse(readFileSync(stateFile(), "utf8"))).toEqual({ tier: "fast" });
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
		expect(existsSync(stateFile())).toBe(false);
		expect(h.ui.notify).toHaveBeenCalledWith("Fast and Ultrafast are off", "info");
		await setTier(h, "ultrafast", "on");
		await setTier(h, "fast", "");
		expect(h.ui.notify).toHaveBeenCalledWith("ultrafast mode is on", "info");
	});
});
