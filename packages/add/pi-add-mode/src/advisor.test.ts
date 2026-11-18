import { describe, expect, test } from "bun:test";
import { ModeEngine } from "./engine.ts";
import { normalizeModeEntry } from "./logic.ts";

function fakeRegistry(captured: { reasoning?: unknown; signal?: unknown }) {
	const model = { provider: "p", id: "m", reasoning: true };
	return {
		find: (provider: string, id: string) => (provider === "p" && id === "m" ? model : undefined),
		streamSimple: (_m: unknown, _ctx: unknown, options?: Record<string, unknown>) => {
			captured.reasoning = options?.reasoning;
			captured.signal = options?.signal;
			return {
				result: async () => ({
					stopReason: "stop",
					content: [{ type: "text", text: "advice" }],
				}),
			};
		},
	};
}

function ctxWith(captured: { reasoning?: unknown; signal?: unknown }) {
	return { modelRegistry: fakeRegistry(captured) } as never;
}

function engineWithAdvisor(advisorModel?: string, advisorThinking?: "high") {
	const engine = new ModeEngine({} as never);
	(engine as unknown as { current: unknown }).current = {
		name: "review",
		enabled: true,
		tools: "default",
		leaderOverride: false,
		advisorModel,
		advisorThinking,
	};
	return engine;
}

describe("advisor mode fields", () => {
	test("normalize keeps the advisor model and optional effort", () => {
		expect(normalizeModeEntry("x", { advisorModel: "p/m", advisorThinking: "high" })).toMatchObject({
			advisorModel: "p/m",
			advisorThinking: "high",
		});
	});

	test("advisor effort is optional; invalid levels drop", () => {
		expect(normalizeModeEntry("x", { advisorModel: "p/m" })?.advisorThinking).toBeUndefined();
		expect(normalizeModeEntry("x", { advisorThinking: "turbo" })?.advisorThinking).toBeUndefined();
	});

	test("unset effort sends the model default (no reasoning param)", async () => {
		const captured: { reasoning?: unknown } = {};
		const { text } = await engineWithAdvisor("p/m").consultAdvisor("q?", ctxWith(captured), undefined);
		expect(text).toBe("advice");
		expect(captured.reasoning).toBeUndefined();
	});

	test("set effort is forwarded", async () => {
		const captured: { reasoning?: unknown } = {};
		await engineWithAdvisor("p/m", "high").consultAdvisor("q?", ctxWith(captured), undefined);
		expect(captured.reasoning).toBe("high");
	});

	test("missing advisor config is an error, not a silent no-op", async () => {
		const captured: { reasoning?: unknown } = {};
		await expect(engineWithAdvisor().consultAdvisor("q?", ctxWith(captured), undefined)).rejects.toThrow(
			"No advisor is configured",
		);
	});
});
