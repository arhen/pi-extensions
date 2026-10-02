import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureUsableModel } from "../src/manager.ts";

interface ProbeCall {
	reasoningEffort?: string;
}

function makeCtx(calls: ProbeCall[], error?: string): ExtensionContext {
	return {
		model: undefined,
		modelRegistry: {
			complete: async (_model: unknown, _context: unknown, options: ProbeCall) => {
				calls.push(options);
				return error ? { stopReason: "error", errorMessage: error } : { stopReason: "stop" };
			},
		},
	} as unknown as ExtensionContext;
}

const nineRouterModel = {
	provider: "9router",
	id: "cc/claude-sonnet-5-5",
	api: "openai-completions",
	reasoning: true,
	thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
} as never;

const plainModel = {
	provider: "local",
	id: "no-reasoning",
	api: "openai-completions",
	reasoning: false,
} as never;

describe("ensureUsableModel preflight", () => {
	test("probes with the requested thinking level", async () => {
		const calls: ProbeCall[] = [];
		const result = await ensureUsableModel(makeCtx(calls), nineRouterModel, undefined, "max");
		expect(result.model).toBe(nineRouterModel);
		expect(calls[0]?.reasoningEffort).toBe("max");
	});

	test("probes with the cheapest supported level when no thinking was requested", async () => {
		const calls: ProbeCall[] = [];
		await ensureUsableModel(makeCtx(calls), nineRouterModel, undefined, undefined);
		expect(calls[0]?.reasoningEffort).toBe("low");
	});

	test("skips the reasoning option for non-reasoning models", async () => {
		const calls: ProbeCall[] = [];
		await ensureUsableModel(makeCtx(calls), plainModel, undefined, undefined);
		expect(calls[0]?.reasoningEffort).toBeUndefined();
	});

	test("keeps the original probe error when the model stays unusable", async () => {
		const calls: ProbeCall[] = [];
		await expect(ensureUsableModel(makeCtx(calls, "boom"), nineRouterModel, undefined, "max")).rejects.toThrow(
			/unusable: boom/,
		);
		expect(calls).toHaveLength(1);
	});
});
