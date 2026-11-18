import { describe, expect, test } from "bun:test";
import { ModeEngine } from "./engine.ts";
import { normalizeModeEntry } from "./logic.ts";

function fakeRegistry(captured: { reasoning?: unknown; signal?: unknown }) {
	const model = { provider: "p", id: "m", reasoning: true, thinkingLevelMap: { high: "high", xhigh: "xhigh" } };
	const other = { provider: "p", id: "other", reasoning: true, thinkingLevelMap: { high: "high", xhigh: "xhigh" } };
	return {
		find: (provider: string, id: string) =>
			provider === "p" && (id === "m" || id === "other") ? (id === "m" ? model : other) : undefined,
		getAvailable: () => [model, other],
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

function completedRun(finalText: string, task?: Record<string, unknown>) {
	return {
		isError: false,
		result: {
			details: {
				run: { id: "run-ok", tasks: [{ status: "completed", finalText, model: "m", provider: "p", ...task }] },
			},
		},
	};
}

function ctxWith(
	captured: { reasoning?: unknown; signal?: unknown },
	subagent?: {
		args?: unknown;
		cancels?: Array<{ runId: string }>;
		outcome?: { isError: boolean; result?: { details?: { run?: { id?: string; tasks?: unknown[] } } } };
	},
) {
	return {
		modelRegistry: fakeRegistry(captured),
		...(subagent
			? {
					tools: [{ name: "subagent" }, { name: "subagent_cancel" }],
					executeTool: async (name: string, args: unknown) => {
						if (name === "subagent_cancel") {
							subagent.cancels?.push(args as { runId: string });
							return { isError: false };
						}
						expect(name).toBe("subagent");
						subagent.args = args;
						return subagent.outcome ?? completedRun("advisor says hi");
					},
				}
			: {}),
	} as never;
}

function engineWithAdvisor(advisorModel?: string, advisorThinking?: import("./types.ts").ModeThinking) {
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

	test("unset effort runs the advisor with thinking off (no reasoning param)", async () => {
		const captured: { reasoning?: unknown } = {};
		const { thinking } = await engineWithAdvisor("p/m").consultAdvisor("q?", ctxWith(captured), undefined);
		expect(thinking).toBe("off");
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
		expect(subagent.args).toHaveProperty("maxRuntimeMs");
		expect(captured.reasoning).toBeUndefined();
	});

	test("unsupported advisor effort clamps to the model's ceiling", async () => {
		const captured: { reasoning?: unknown } = {};
		const subagent: { args?: unknown } = {};
		const engine = engineWithAdvisor("p/m", "max");
		const result = await engine.consultAdvisor("q?", ctxWith(captured, subagent), undefined, "call-1");
		expect(result.thinking).toBe("xhigh");
		expect((subagent.args as Record<string, unknown>).thinking).toBe("xhigh");
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
			return completedRun("ok");
		};
		await engine.consultAdvisor("q?", ctx, undefined, "call-9");
		expect(nestedInput?.model).toBe("p/m");
		expect(nestedInput?.thinking).toBe("off");
	});

	test("mode-forced subagent thinking clamps to the forced model's ceiling", async () => {
		const engine = new ModeEngine({} as never);
		(engine as unknown as { current: unknown }).current = {
			name: "review",
			enabled: true,
			tools: "default",
			leaderOverride: false,
			subagentModel: "p/other",
			subagentThinking: "max",
		};
		const captured: { reasoning?: unknown } = {};
		const ctx = ctxWith(captured);
		const input: Record<string, unknown> = {
			tasks: [{ agent: "a", task: "t", model: "p/leader", thinking: "high" }],
		};
		engine.onToolCall({ toolName: "subagent", input } as never, ctx);
		expect(input.tasks).toEqual([{ agent: "a", task: "t", model: "p/other", thinking: "xhigh" }]);
	});

	test("leader-pinned subagent pairs clamp too when the mode allows overrides", async () => {
		const engine = new ModeEngine({} as never);
		(engine as unknown as { current: unknown }).current = {
			name: "review",
			enabled: true,
			tools: "default",
			leaderOverride: true,
		};
		const captured: { reasoning?: unknown } = {};
		const ctx = ctxWith(captured);
		const input: Record<string, unknown> = {
			tasks: [{ agent: "a", task: "t", model: "p/other", thinking: "max" }],
		};
		engine.onToolCall({ toolName: "subagent", input } as never, ctx);
		expect(input.tasks).toEqual([{ agent: "a", task: "t", model: "p/other", thinking: "xhigh" }]);
	});

	test("fallback cancels a spawned advisor run that will not be used", async () => {
		const captured: { reasoning?: unknown } = {};
		const subagent: { cancels?: Array<{ runId: string }> } = { cancels: [] };
		const result = await engineWithAdvisor("p/m").consultAdvisor(
			"q?",
			ctxWith(captured, {
				...subagent,
				outcome: {
					isError: false,
					result: { details: { run: { id: "run-9", tasks: [{ status: "failed", finalText: "" }] } } },
				},
			}),
			undefined,
			"call-2",
		);
		expect(result.via).toBe("direct");
		expect(subagent.cancels).toEqual([{ runId: "run-9" }]);
	});

	test("no subagent tool labels the one-shot as answering without repo access", async () => {
		const captured: { reasoning?: unknown } = {};
		const result = await engineWithAdvisor("p/m").consultAdvisor("q?", ctxWith(captured), undefined, "call-5");
		expect(result.via).toBe("direct");
		expect(result.text).toContain("subagent tool unavailable");
		expect(result.text).toContain("advice");
	});

	test("a failed advisor run is not returned as advice", async () => {
		const captured: { reasoning?: unknown } = {};
		const result = await engineWithAdvisor("p/m").consultAdvisor(
			"q?",
			ctxWith(captured, {
				outcome: {
					isError: false,
					result: { details: { run: { tasks: [{ status: "failed", finalText: "" }] } } },
				},
			}),
			undefined,
			"call-3",
		);
		expect(result.via).toBe("direct");
		expect(result.text).toContain("advisor run failed");
	});

	test.each([
		["model substituted", { modelNote: "fell back to session model" }],
		["agent file takeover", { agentFile: ".pi/agents/advisor.md" }],
		["wrong model", { model: "other" }],
	] as const)("falls back when %s", async (_label, task) => {
		const captured: { reasoning?: unknown } = {};
		const result = await engineWithAdvisor("p/m").consultAdvisor(
			"q?",
			ctxWith(captured, { outcome: completedRun("sneaky", task) }),
			undefined,
			"call-4",
		);
		expect(result.via).toBe("direct");
		expect(result.text).not.toContain("sneaky");
	});

	test("activate adds the advisor tool only when the mode configures it", async () => {
		const active: string[][] = [];
		const pi = {
			getThinkingLevel: () => "medium",
			getActiveTools: () => ["read", "bash"],
			getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "advisor" }, { name: "subagent" }],
			setActiveTools: (tools: string[]) => active.push(tools),
			setThinkingLevel: () => {},
			events: { emit: () => {} },
		} as never;
		const ui = {
			theme: {},
			setWorkingMessage: () => {},
			setWorkingIndicator: () => {},
			setWidget: () => {},
		};
		const activate = async (mode: Record<string, unknown>) => {
			const engine = new ModeEngine(pi);
			engine.setStore({ get: () => mode } as never);
			await engine.activate("review", { model: undefined, modelRegistry: { find: () => undefined }, ui } as never);
		};
		await activate({ name: "review", enabled: true, tools: ["read"], leaderOverride: false, advisorModel: "p/m" });
		expect(active.at(-1)).toContain("advisor");
		await activate({ name: "review", enabled: true, tools: ["read", "grep"], leaderOverride: false });
		expect(active.at(-1)).not.toContain("advisor");
		await activate({
			name: "review",
			enabled: true,
			tools: ["read", "advisor"],
			leaderOverride: false,
		});
		expect(active.at(-1)).not.toContain("advisor");
	});

	test("activate warns when a mode's advisor or subagent pair is invalid", async () => {
		const pi = {
			getThinkingLevel: () => "medium",
			getActiveTools: () => ["read"],
			getAllTools: () => [{ name: "read" }, { name: "advisor" }],
			setActiveTools: () => {},
			setThinkingLevel: () => {},
			setModel: async () => true,
			events: { emit: () => {} },
		} as never;
		const ui = {
			theme: {},
			setWorkingMessage: () => {},
			setWorkingIndicator: () => {},
			setWidget: () => {},
		};
		const capped = { provider: "p", id: "other", reasoning: true, thinkingLevelMap: { high: "high", xhigh: "xhigh" } };
		const registry = {
			find: (provider: string, id: string) => (provider === "p" && id === "other" ? capped : undefined),
		};
		const engine = new ModeEngine(pi);
		engine.setStore({
			get: () => ({ name: "review", enabled: true, tools: "default", leaderOverride: false }),
		} as never);
		const missing = await engine.activate("review", { model: undefined, modelRegistry: registry, ui } as never);
		expect(missing.ok).toBe(true);

		engine.setStore({
			get: () => ({
				name: "review",
				enabled: true,
				tools: "default",
				leaderOverride: false,
				advisorModel: "p/gone",
			}),
		} as never);
		const advisorGone = await engine.activate("review", { model: undefined, modelRegistry: registry, ui } as never);
		expect(advisorGone.message).toContain("advisor model p/gone not found");

		engine.setStore({
			get: () => ({
				name: "review",
				enabled: true,
				tools: "default",
				leaderOverride: false,
				subagentModel: "p/other",
				subagentThinking: "max",
			}),
		} as never);
		const clamped = await engine.activate("review", { model: undefined, modelRegistry: registry, ui } as never);
		expect(clamped.message).toContain("runs at xhigh");
	});

	test("missing advisor config is an error, not a silent no-op", async () => {
		const captured: { reasoning?: unknown } = {};
		await expect(engineWithAdvisor().consultAdvisor("q?", ctxWith(captured), undefined)).rejects.toThrow(
			"No advisor is configured",
		);
	});
});
