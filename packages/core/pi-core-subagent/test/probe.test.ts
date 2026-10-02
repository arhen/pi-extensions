import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampResumeThinking, ensureUsableModel } from "../src/manager.ts";

interface ProbeCall {
	reasoningEffort?: string;
}

// 9router passes reasoning_effort to the upstream Anthropic API as a thinking config.
// "none" (what the adapter sends for an omitted effort when thinkingLevelMap.off = "none")
// is rejected by adaptive models like cc/claude-sonnet-5-5; every real level works.
const NINE_ROUTER_OFF_REJECTION =
	'400: {"type":"error","error":{"type":"invalid_request_error","message":"To turn thinking off on this model, send \\"thinking\\": {\\"type\\": \\"between_tools\\"} instead of {\\"type\\": \\"disabled\\"}. The model does not think before responding."}}';

function makeCtx(
	calls: ProbeCall[],
	opts: { session?: unknown; errorFor?: (effort: string | undefined) => string | undefined } = {},
): ExtensionContext {
	return {
		model: opts.session,
		modelRegistry: {
			complete: async (_model: unknown, _context: unknown, options: ProbeCall) => {
				calls.push(options);
				const error = opts.errorFor?.(options.reasoningEffort);
				return error ? { stopReason: "error", errorMessage: error } : { stopReason: "stop" };
			},
		},
	} as unknown as ExtensionContext;
}

/** Probe emulating the 9router routes: omitting the effort means "none", which 400s. */
function makeNineRouterCtx(calls: ProbeCall[], session?: unknown): ExtensionContext {
	return makeCtx(calls, {
		session,
		errorFor: (effort) => (effort === undefined || effort === "none" ? NINE_ROUTER_OFF_REJECTION : undefined),
	});
}

const nineRouterModel = {
	provider: "9router",
	id: "cc/claude-sonnet-5-5",
	api: "openai-completions",
	reasoning: true,
	thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
} as never;

const sessionModel = {
	provider: "9router",
	id: "cc/claude-opus-5-5",
	api: "openai-completions",
	reasoning: true,
} as never;

const plainModel = {
	provider: "local",
	id: "no-reasoning",
	api: "openai-completions",
	reasoning: false,
} as never;

describe("ensureUsableModel preflight", () => {
	test("probes with the level the child will actually run (clamped to what the model accepts)", async () => {
		const calls: ProbeCall[] = [];
		const result = await ensureUsableModel(makeNineRouterCtx(calls), nineRouterModel, undefined, "max");
		expect(result.model).toBe(nineRouterModel);
		expect(result.note).toBeUndefined();
		// the extension's map has no "max", so a real session clamps max -> xhigh; the probe must match
		expect(calls[0]?.reasoningEffort).toBe("xhigh");
	});

	test("probes the exact requested level when the model declares it", async () => {
		const calls: ProbeCall[] = [];
		await ensureUsableModel(makeNineRouterCtx(calls), nineRouterModel, undefined, "high");
		expect(calls[0]?.reasoningEffort).toBe("high");
	});

	test("a model that cannot disable thinking probes its cheapest level for a thinking-off task", async () => {
		const calls: ProbeCall[] = [];
		const cannotDisable = {
			provider: "x",
			id: "always-thinks",
			api: "openai-completions",
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
		} as never;
		const result = await ensureUsableModel(makeCtx(calls), cannotDisable, undefined, "off");
		expect(result.model).toBe(cannotDisable);
		expect(calls[0]?.reasoningEffort).toBe("low");
	});

	test("probes with the cheapest supported level when no thinking was requested", async () => {
		const calls: ProbeCall[] = [];
		const result = await ensureUsableModel(makeNineRouterCtx(calls), nineRouterModel, undefined, undefined);
		expect(result.model).toBe(nineRouterModel);
		expect(result.note).toBeUndefined();
		expect(calls[0]?.reasoningEffort).toBe("low");
	});

	test("skips the reasoning option for non-reasoning models", async () => {
		const calls: ProbeCall[] = [];
		await ensureUsableModel(makeCtx(calls), plainModel, undefined, undefined);
		expect(calls[0]?.reasoningEffort).toBeUndefined();
	});

	test("a model that cannot run thinking-off still falls back, with a visible note", async () => {
		const calls: ProbeCall[] = [];
		const result = await ensureUsableModel(makeNineRouterCtx(calls, sessionModel), nineRouterModel, undefined, "off");
		expect(result.model).toBe(sessionModel);
		expect(result.note).toMatch(/cc\/claude-sonnet-5-5 failed preflight/);
		expect(result.note).toMatch(/using session model 9router\/cc\/claude-opus-5-5/);
	});

	test("keeps the original probe error when the model stays unusable", async () => {
		const calls: ProbeCall[] = [];
		await expect(
			ensureUsableModel(makeCtx(calls, { errorFor: () => "boom" }), nineRouterModel, undefined, "max"),
		).rejects.toThrow(/unusable: boom/);
		expect(calls).toHaveLength(1);
	});
});

describe("resume thinking clamp", () => {
	const deepseekLike = {
		provider: "opencode-go",
		id: "deepseek-v4.1-flash",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	} as never;

	test("clamps a stored level the target model rejects (xhigh on low|high|max)", () => {
		const clamped = clampResumeThinking(deepseekLike, "xhigh");
		expect(clamped).not.toBe("xhigh");
		expect(clamped).toBe("max");
	});

	test("keeps a level the model accepts", () => {
		expect(clampResumeThinking(deepseekLike, "high")).toBe("high");
	});

	test("passes through without a model or a level", () => {
		expect(clampResumeThinking(undefined, "xhigh")).toBe("xhigh");
		expect(clampResumeThinking(deepseekLike, undefined)).toBeUndefined();
	});
});
