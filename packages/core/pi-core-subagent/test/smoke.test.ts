import { describe, expect, test } from "bun:test";
import { createChildTools } from "../src/child.ts";
import { createMailbox } from "../src/mailbox.ts";
import { classifyFailure, ensureUsableModel, resolveChildModel, validateThinking } from "../src/manager.ts";

describe("classifyFailure", () => {
	test("stop/end/undefined → no failure (normal completion)", () => {
		expect(classifyFailure("stop")).toBeUndefined();
		expect(classifyFailure("end")).toBeUndefined();
		expect(classifyFailure(undefined)).toBeUndefined();
	});
	test("aborted → aborted status", () => {
		expect(classifyFailure("aborted")?.status).toBe("aborted");
	});
	test("any other stopReason → failed", () => {
		for (const reason of ["max_tokens", "refusal", "length", "error"]) {
			expect(classifyFailure(reason)?.status).toBe("failed");
		}
	});
});

describe("poll_agent_messages cap", () => {
	const tools = createChildTools("task_1", {
		onAskParent: async () => "ok",
		onNotifyParent: () => {},
		onSendMessage: () => true,
		onPollMailbox: () => [{ from: "task_2", text: "x".repeat(5000), at: 0 }],
	});
	const poll = tools.find((t) => t.name === "poll_agent_messages")!;

	test("mailbox dump is capped at 4000 chars", async () => {
		const res = await (poll.execute as unknown as () => Promise<{ content: { text: string }[] }>)();
		const text = (res as unknown as { content: { text: string }[] }).content[0]!.text;
		expect(text).toHaveLength(4000);
	});
	test("truncation does not split a surrogate pair", async () => {
		const emoji = createChildTools("task_1", {
			onAskParent: async () => "ok",
			onNotifyParent: () => {},
			onSendMessage: () => true,
			onPollMailbox: () => [{ from: "task_2", text: `a${String.fromCodePoint(0x1f600).repeat(2000)}`, at: 0 }],
		});
		const emojiPoll = emoji.find((t) => t.name === "poll_agent_messages")!;
		const res = await (emojiPoll.execute as unknown as () => Promise<{ content: { text: string }[] }>)();
		const text = (res as unknown as { content: { text: string }[] }).content[0]!.text;
		const last = text.charCodeAt(text.length - 1);
		expect(last < 0xd800 || last > 0xdbff).toBe(true);
		expect(text.length).toBeLessThanOrEqual(4000);
	});
});

describe("mailbox", () => {
	test("send + poll routes and drains", () => {
		const mb = createMailbox();
		mb.open("task_1");
		mb.open("task_2");
		mb.send("task_1", "task_2", "hi there");
		expect(mb.poll("task_1")).toHaveLength(0);
		const got = mb.poll("task_2");
		expect(got).toHaveLength(1);
		expect(got[0]!.text).toBe("hi there");
		expect(got[0]!.from).toBe("task_1");
		expect(mb.poll("task_2")).toHaveLength(0);
	});
	test("unknown target rejected", () => {
		const mb = createMailbox();
		mb.open("task_1");
		expect(mb.send("task_1", "nope", "x")).toBe(false);
	});
	test("unknown sender rejected", () => {
		const mb = createMailbox();
		mb.open("task_1");
		expect(mb.send("ghost", "task_1", "x")).toBe(false);
	});
});

describe("validateThinking", () => {
	const reasoningModel = {
		id: "m",
		name: "m",
		provider: "p",
		reasoning: true,
		thinkingLevelMap: { low: null, high: "high", max: "max" },
	} as never;
	const noReasoningModel = { id: "m", name: "m", provider: "p", reasoning: false } as never;
	const noMapModel = { id: "m", name: "m", provider: "p", reasoning: true } as never;

	test("null in thinkingLevelMap → rejected with supported list", () => {
		expect(() => validateThinking(reasoningModel, "low")).toThrow(/not supported.*Supported: high \| max/);
	});
	test("supported level passes", () => {
		expect(() => validateThinking(reasoningModel, "high")).not.toThrow();
		expect(() => validateThinking(reasoningModel, "max")).not.toThrow();
	});
	test("missing key falls back to provider default", () => {
		expect(() => validateThinking(reasoningModel, "medium")).not.toThrow();
	});
	test("off always allowed", () => {
		expect(() => validateThinking(reasoningModel, "off")).not.toThrow();
		expect(() => validateThinking(noReasoningModel, "off")).not.toThrow();
	});
	test("non-reasoning model rejects thinking", () => {
		expect(() => validateThinking(noReasoningModel, "high")).toThrow(/does not support thinking/);
	});
	test("no map + reasoning → provider defaults", () => {
		expect(() => validateThinking(noMapModel, "high")).not.toThrow();
	});
	test("undefined model/level → no-op", () => {
		expect(() => validateThinking(undefined, "high")).not.toThrow();
		expect(() => validateThinking(reasoningModel, "undefined")).not.toThrow();
	});
});

describe("resolveChildModel", () => {
	const models = [
		{ provider: "9router", id: "cc/claude-opus-5" },
		{ provider: "anthropic", id: "claude-opus-5" },
	] as never[];
	const ctx = {
		model: { provider: "parent", id: "inherited" },
		modelRegistry: {
			getAvailable: () => models,
			find: (p: string, id: string) =>
				models.find(
					(m: never) =>
						(m as never as { provider: string; id: string }).provider === p && (m as never as { id: string }).id === id,
				),
		},
	} as never as Parameters<typeof resolveChildModel>[0];

	test("resolves provider/id where the id itself contains slashes", () => {
		expect(resolveChildModel(ctx, "9router/cc/claude-opus-5")).toBe(models[0]);
	});
	test("resolves a bare id", () => {
		expect(resolveChildModel(ctx, "claude-opus-5")).toBe(models[1]);
	});
	test("inherits the parent model when unset", () => {
		expect(resolveChildModel(ctx, undefined)).toMatchObject({ provider: "parent", id: "inherited" });
	});
	test("throws on unknown refs", () => {
		expect(() => resolveChildModel(ctx, "cc/nope")).toThrow("Model not found");
	});

	test("a bare id prefers the SESSION's provider over registry order", () => {
		const shared = [
			{ provider: "commandcode", id: "claude-sonnet-5" },
			{ provider: "anthropic", id: "claude-sonnet-5" },
		] as never[];
		const sessionCtx = {
			model: { provider: "anthropic", id: "claude-opus-5" },
			modelRegistry: { getAvailable: () => shared, find: () => undefined },
		} as never as Parameters<typeof resolveChildModel>[0];
		expect(resolveChildModel(sessionCtx, "claude-sonnet-5")).toBe(shared[1]);
	});
	test("a bare id also matches the session provider's PREFIXED form (9router/cc/*)", () => {
		const sessionCtx = {
			model: { provider: "9router", id: "cc/claude-opus-5" },
			modelRegistry: { getAvailable: () => models, find: () => undefined },
		} as never as Parameters<typeof resolveChildModel>[0];
		expect(resolveChildModel(sessionCtx, "claude-opus-5")).toBe(models[0]);
	});
});

describe("ensureUsableModel", () => {
	const session = { provider: "9router", id: "cc/claude-opus-5" } as never;
	const other = { provider: "commandcode", id: "claude-sonnet-5" } as never;
	const makeCtx = (complete: () => Promise<unknown>) =>
		({ model: session, modelRegistry: { complete } }) as never as Parameters<typeof ensureUsableModel>[0];

	test("the session's own model is never probed — it answered this very turn", async () => {
		let probes = 0;
		const ctx = makeCtx(async () => {
			probes++;
			return {};
		});
		expect(await ensureUsableModel(ctx, session, undefined)).toMatchObject({ model: session });
		expect(probes).toBe(0);
	});
	test("a model that answers is kept, with no note", async () => {
		const ctx = makeCtx(async () => ({ stopReason: "stop" }));
		const out = await ensureUsableModel(ctx, other, undefined);
		expect(out.model).toBe(other);
		expect(out.note).toBeUndefined();
	});
	test("a 403 falls back to the session model and says so", async () => {
		const ctx = makeCtx(async () => ({ stopReason: "error", errorMessage: "403 MODEL_NOT_IN_PLAN" }));
		const out = await ensureUsableModel(ctx, other, undefined);
		expect(out.model).toBe(session);
		expect(out.note).toContain("MODEL_NOT_IN_PLAN");
		expect(out.note).toContain("cc/claude-opus-5");
	});
	test("a thrown transport error falls back too", async () => {
		const ctx = makeCtx(async () => {
			throw new Error("ECONNREFUSED");
		});
		expect(await ensureUsableModel(ctx, other, undefined)).toMatchObject({ model: session });
	});
	test("with no session model to fall back to, an unusable model throws", async () => {
		const ctx = {
			model: undefined,
			modelRegistry: { complete: async () => ({ stopReason: "error", errorMessage: "401" }) },
		} as never as Parameters<typeof ensureUsableModel>[0];
		expect(ensureUsableModel(ctx, other, undefined)).rejects.toThrow(/unusable/);
	});
});
