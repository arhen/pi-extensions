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

function ctxWith(
	captured: { reasoning?: unknown; signal?: unknown },
	subagent?: {
		args?: unknown;
		outcome?: { isError: boolean; result?: { content: { type: string; text?: string }[] } };
	},
) {
	return {
		modelRegistry: fakeRegistry(captured),
		...(subagent
			? {
					tools: [{ name: "subagent" }],
					executeTool: async (name: string, args: unknown) => {
						expect(name).toBe("subagent");
						subagent.args = args;
						return (
							subagent.outcome ?? {
								isError: false,
								result: { content: [{ type: "text", text: "advisor says hi" }] },
							}
						);
					},
				}
			: {}),
	} as never;
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

	test("active mode with an advisor injects use-the-advisor guidance", () => {
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		engineWithAdvisor("p/m", "high").onBeforeAgentStart(event as never);
		const section = event.systemPromptOptions.sections.mode;
		expect(section).toContain("Use the `advisor` tool");
		expect(section).toContain("p/m");
		expect(section).toContain("UNTRUSTED");
	});

	test("mode without an advisor adds no advisor guidance", () => {
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		engineWithAdvisor().onBeforeAgentStart(event as never);
		expect(event.systemPromptOptions.sections.mode ?? "").not.toContain("advisor");
	});

	test("prefers a read-only subagent run when available", async () => {
		const captured: { reasoning?: unknown } = {};
		const subagent: { args?: unknown } = {};
		const engine = engineWithAdvisor("p/m", "high");
		const result = await engine.consultAdvisor("q?", ctxWith(captured, subagent), undefined, "call-1");
		expect(result).toMatchObject({ text: "advisor says hi", model: "p/m", thinking: "high", via: "subagent" });
		expect(subagent.args).toMatchObject({
			agent: "advisor",
			task: "q?",
			model: "p/m",
			thinking: "high",
			autoAwait: true,
		});
		expect(captured.reasoning).toBeUndefined();
	});

	test("mode enforcement skips calls nested under an advisor execution", async () => {
		const captured: { reasoning?: unknown } = {};
		const subagent: { args?: unknown } = {};
		const engine = new ModeEngine({} as never);
		(engine as unknown as { current: unknown }).current = {
			name: "review",
			enabled: true,
			tools: "default",
			leaderOverride: false,
			subagentModel: "p/other",
			subagentThinking: "low",
			advisorModel: "p/m",
		};
		let nestedInput: Record<string, unknown> | undefined;
		const ctx = ctxWith(captured, subagent);
		(ctx as unknown as { executeTool: unknown }).executeTool = async (_name: string, args: unknown) => {
			subagent.args = args;
			nestedInput = { ...(args as Record<string, unknown>) };
			engine.onToolCall({ toolName: "subagent", input: nestedInput, parentToolCallId: "call-9" } as never);
			return { isError: false, result: { content: [{ type: "text", text: "ok" }] } };
		};
		await engine.consultAdvisor("q?", ctx, undefined, "call-9");
		expect(nestedInput?.model).toBe("p/m");
		expect(nestedInput).not.toHaveProperty("thinking");
	});

	test("subagent failure falls back to the isolated one-shot", async () => {
		const captured: { reasoning?: unknown } = {};
		const result = await engineWithAdvisor("p/m").consultAdvisor(
			"q?",
			ctxWith(captured, { outcome: { isError: true } }),
			undefined,
			"call-2",
		);
		expect(result).toMatchObject({ text: "advice", via: "direct" });
	});

	test("missing advisor config is an error, not a silent no-op", async () => {
		const captured: { reasoning?: unknown } = {};
		await expect(engineWithAdvisor().consultAdvisor("q?", ctxWith(captured), undefined)).rejects.toThrow(
			"No advisor is configured",
		);
	});
});
