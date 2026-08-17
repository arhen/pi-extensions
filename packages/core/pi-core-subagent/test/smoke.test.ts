/**
 * Smoke tests: failure classification + mailbox routing + watchdog.
 * Pure logic only — no pi runtime needed. Run: bun test
 */
import { describe, expect, test } from "bun:test";
import { createChildTools, createWatchdog } from "../src/child.ts";
import { createMailbox } from "../src/mailbox.ts";
import { classifyFailure, resolveChildModel, validateThinking } from "../src/manager.ts";

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
		// 12-char prefix + "a" shifts the 4000-cut onto an odd boundary inside an emoji.
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
		expect(last < 0xd800 || last > 0xdbff).toBe(true); // no lone high surrogate
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
		expect(mb.poll("task_2")).toHaveLength(0); // drained
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

describe("watchdog", () => {
	test("dispose resolves nothing and is idempotent", async () => {
		const wd = createWatchdog(10_000, "test");
		wd.dispose();
		wd.dispose();
		expect(wd).toBeTruthy();
	});

	test("rejects after stall when untouched; touch keeps it alive", async () => {
		const wd = createWatchdog(40, "test");
		wd.touch();
		// interval floor is 1s, so detection takes >= ~1s even for tiny stallMs
		const t0 = Date.now();
		const err = await wd.promise.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toMatch(/stalled/);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
		wd.dispose();
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
	// Model ids may contain slashes (9router/cc/claude-opus-5), so the first "/"
	// is not always the provider boundary.
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
});
