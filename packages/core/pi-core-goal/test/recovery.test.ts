import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import goalExtension from "../src/index.ts";

const NOW = Date.parse("2026-06-01T00:00:00Z");
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type SentMessage = { customType: string; content: string; details?: { goalId?: string; continuationId?: string } };

function createClock() {
	let now = NOW;
	const timers = new Map<object, { at: number; callback: () => void }>();
	spyOn(Date, "now").mockImplementation(() => now);
	spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
		const handle = { unref: () => handle };
		timers.set(handle, { at: now + delay, callback });
		return handle;
	}) as unknown as typeof setTimeout);
	spyOn(globalThis, "clearTimeout").mockImplementation(((handle: object) => {
		timers.delete(handle);
	}) as unknown as typeof clearTimeout);
	return {
		timers,
		now: () => now,
		advance(ms: number) {
			const target = now + ms;
			for (;;) {
				const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
				if (!next || next[1].at > target) break;
				now = next[1].at;
				timers.delete(next[0]);
				next[1].callback();
			}
			now = target;
		},
	};
}

function createHarness(savedGoal?: Record<string, unknown>) {
	const clock = createClock();
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, Command>();
	const tools = new Map<string, Tool>();
	const sent: SentMessage[] = [];
	const statuses = new Map<string, string | undefined>();
	const notifications: string[] = [];
	const confirmations: string[] = [];
	const state = { idle: true, pending: false, sessionId: "session-1", failSends: 0, confirmPause: true };
	const branch: any[] = savedGoal
		? [{ type: "custom", customType: "goal", data: { version: 2, action: "status", goal: savedGoal } }]
		: [];
	const ctx = {
		hasUI: true,
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		sessionManager: { getBranch: () => branch, getSessionId: () => state.sessionId },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			notify: (text: string) => notifications.push(text),
			confirm: async (title: string) => {
				confirmations.push(title);
				return state.confirmPause;
			},
			editor: async () => "edited objective",
		},
	} as unknown as ExtensionContext;
	const api = {
		on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
		sendMessage: (message: SentMessage) => {
			if (message.customType === "goal-continuation" && state.failSends > 0) {
				state.failSends--;
				throw new Error("queue unavailable");
			}
			sent.push(message);
		},
	} as unknown as ExtensionAPI;
	goalExtension(api);
	async function emit(name: string, event: unknown = {}) {
		return handlers.get(name)?.(event, ctx);
	}
	async function command(args: string) {
		await commands.get("goal")!.handler(args, ctx as any);
	}
	async function tool(name: string, params: any = {}) {
		return tools.get(name)!.execute("call", params, new AbortController().signal, undefined, ctx as any);
	}
	async function start() {
		await emit("before_agent_start", { systemPrompt: "base" });
		state.idle = false;
		await emit("agent_start");
		const continuation = sent.filter((message) => message.customType === "goal-continuation").at(-1);
		if (continuation) await emit("message_start", { message: { ...continuation, role: "custom" } });
	}
	async function end(error?: string, usage = 0) {
		await emit("agent_end", {
			messages: [
				{
					role: "assistant",
					stopReason: error ? "error" : "stop",
					errorMessage: error,
					usage: { input: usage, output: 0 },
				},
			],
		});
	}
	async function settle(abortedDuringRecovery = false) {
		if (!abortedDuringRecovery) await emit("agent_before_settle", { outcome: "completed" });
		state.idle = true;
		await emit("agent_settled");
	}
	async function limited(error = "Usage limit reached") {
		await start();
		await end(error);
		await settle();
	}
	return {
		clock,
		state,
		ctx,
		branch,
		sent,
		statuses,
		notifications,
		confirmations,
		emit,
		command,
		tool,
		start,
		end,
		settle,
		limited,
		goal: () => branch.at(-1)?.data.goal,
		continuations: () => sent.filter((message) => message.customType === "goal-continuation"),
	};
}

function savedGoal(overrides: Record<string, unknown> = {}) {
	return {
		id: "goal-1",
		objective: "ship it",
		status: "usageLimited",
		tokensUsed: 10,
		timeUsedSeconds: 20,
		createdAt: NOW / 1_000,
		updatedAt: NOW / 1_000,
		usageRetry: { attempt: 2, retryAt: NOW + 5 * 60_000 },
		...overrides,
	};
}

afterEach(() => mock.restore());

test("waits for settlement and reset before queuing one automatic retry", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.start();
	await h.end("Usage limit reached. Try again in 2 minutes.");
	expect(h.goal().status).toBe("active");
	expect(h.clock.timers.size).toBe(0);
	expect(h.continuations()).toHaveLength(1);
	await h.settle();
	expect(h.goal().status).toBe("usageLimited");
	await h.settle();
	expect(h.clock.timers.size).toBe(1);
	expect(h.statuses.get("goal")).toContain("auto-retry at");
	const result = await h.tool("get_goal");
	expect((result.details as { goal: { usageRetry: unknown } }).goal.usageRetry).toEqual({
		attempt: 1,
		retryAt: NOW + 150_000,
	});
	h.clock.advance(149_999);
	expect(h.continuations()).toHaveLength(1);
	h.clock.advance(1);
	expect(h.continuations()).toHaveLength(2);
	expect(h.goal().status).toBe("active");
	expect(h.goal().timeUsedSeconds).toBe(0);
	await h.start();
	expect(h.clock.timers.size).toBe(0);
});

test("native recovery success does not leave a stale quota retry", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.start();
	await h.end("429: Too Many Requests");
	await h.emit("agent_start");
	await h.end();
	await h.settle();
	expect(h.goal().status).toBe("active");
	expect(h.goal().usageRetry).toBeUndefined();
	expect(h.continuations()).toHaveLength(2);
	await h.start();
	expect(h.clock.timers.size).toBe(0);
});

test("abort during native recovery prompts to pause before classifying the pending quota error", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.start();
	await h.end("429: Too Many Requests");
	await h.settle(true);
	expect(h.confirmations).toContain("Pause active goal?");
	expect(h.goal().status).toBe("paused");
	expect(h.clock.timers.size).toBe(0);
});

test("declining the native recovery pause still queues quota recovery", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.start();
	await h.end("429: Too Many Requests");
	h.state.confirmPause = false;
	await h.settle(true);
	expect(h.goal().status).toBe("usageLimited");
	expect(h.clock.timers.size).toBe(1);
});

test("native recovery exhaustion schedules one quota retry after the final failure", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.start();
	await h.end("429: Too Many Requests");
	await h.emit("agent_start");
	await h.end("429: Too Many Requests. Retry after 10 minutes");
	await h.settle();
	expect(h.goal().usageRetry).toEqual({ attempt: 1, retryAt: NOW + 630_000 });
	expect(h.clock.timers.size).toBe(1);
});

test("requeues repeated quota failures, resets backoff after success, and stops when done", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.limited();
	expect(h.goal().usageRetry.attempt).toBe(1);
	h.clock.advance(5 * 60_000);
	await h.limited();
	expect(h.goal().usageRetry).toEqual({ attempt: 2, retryAt: NOW + 15 * 60_000 });
	h.clock.advance(10 * 60_000);
	await h.start();
	h.clock.advance(2_000);
	await h.end(undefined, 100);
	expect(h.goal().usageRetry).toBeUndefined();
	expect(h.goal().tokensUsed).toBe(100);
	expect(h.goal().timeUsedSeconds).toBe(2);
	await h.settle();
	await h.limited();
	expect(h.goal().usageRetry.attempt).toBe(1);
	await h.tool("update_goal", { status: "complete" });
	const count = h.continuations().length;
	h.clock.advance(86_400_000);
	await h.settle();
	expect(h.goal().status).toBe("complete");
	expect(h.continuations()).toHaveLength(count);
	expect(h.clock.timers.size).toBe(0);
});

for (const command of ["pause", "clear", "replacement objective"]) {
	test(`${command} cancels old quota retries`, async () => {
		const h = createHarness();
		await h.command("ship it");
		await h.limited();
		const staleTimer = [...h.clock.timers.values()][0]!;
		await h.command(command);
		const count = h.continuations().length;
		staleTimer.callback();
		if (command === "replacement objective") await h.start();
		h.clock.advance(86_400_000);
		expect(h.continuations()).toHaveLength(count);
		expect(h.clock.timers.size).toBe(0);
	});
}

test("manual resume retries immediately and cancels the delayed retry", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.limited();
	await h.command("resume");
	expect(h.goal().status).toBe("active");
	expect(h.goal().usageRetry).toBeUndefined();
	expect(h.continuations()).toHaveLength(2);
	await h.start();
	h.clock.advance(60 * 60_000);
	expect(h.continuations()).toHaveLength(2);
});

test("manual input while waiting resumes goal instructions and rearms on another quota error", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.limited();
	const prompt = (await h.emit("before_agent_start", { systemPrompt: "base" })) as { systemPrompt: string };
	expect(prompt.systemPrompt).toContain("Active thread goal");
	expect(h.clock.timers.size).toBe(0);
	await h.limited();
	expect(h.goal().usageRetry.attempt).toBe(2);
	expect(h.clock.timers.size).toBe(1);
});

test("defers overdue retries while busy or while other messages are pending", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.limited();
	h.state.idle = false;
	h.clock.advance(5 * 60_000);
	expect(h.goal().status).toBe("usageLimited");
	expect(h.continuations()).toHaveLength(1);
	h.state.idle = true;
	h.state.pending = true;
	h.clock.advance(30_000);
	expect(h.continuations()).toHaveLength(1);
	h.state.pending = false;
	h.clock.advance(30_000);
	expect(h.continuations()).toHaveLength(2);
});

test("unacknowledged continuations are resubmitted after asynchronous delivery loss", async () => {
	const h = createHarness();
	await h.command("ship it");
	const lost = h.continuations()[0]!;
	h.clock.advance(60_000);
	expect(h.continuations()).toHaveLength(2);
	expect(h.continuations()[1]!.details?.continuationId).not.toBe(lost.details?.continuationId);
	await h.emit("message_start", { message: { ...lost, role: "custom" } });
	expect(h.clock.timers.size).toBe(1);
	await h.start();
	expect(h.clock.timers.size).toBe(0);
});

test("delivery receipts survive unrelated agent runs without duplicating a queued continuation", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.emit("agent_start");
	await h.end();
	await h.settle();
	expect(h.continuations()).toHaveLength(1);
	h.state.pending = true;
	h.clock.advance(60_000);
	expect(h.continuations()).toHaveLength(1);
	h.state.pending = false;
	h.clock.advance(60_000);
	expect(h.continuations()).toHaveLength(2);
});

for (const stop of ["pause", "clear"]) {
	test(`${stop} cancels continuation delivery recovery`, async () => {
		const h = createHarness();
		await h.command("ship it");
		const stale = [...h.clock.timers.values()][0]!;
		await h.command(stop);
		stale.callback();
		h.clock.advance(60_000);
		expect(h.continuations()).toHaveLength(1);
		expect(h.clock.timers.size).toBe(0);
	});
}

test("retries synchronous queue failures without losing the goal", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.limited();
	h.state.failSends = 1;
	h.clock.advance(5 * 60_000);
	expect(h.goal().status).toBe("usageLimited");
	expect(h.clock.timers.size).toBe(1);
	expect(h.notifications).toContain("Failed to queue goal continuation: queue unavailable");
	h.clock.advance(60_000);
	expect(h.goal().status).toBe("active");
	expect(h.continuations()).toHaveLength(2);
});

test("restores a saved quota retry after reload and stops old runtime callbacks", async () => {
	const h = createHarness(savedGoal());
	await h.emit("session_start");
	expect(h.clock.timers.size).toBe(1);
	const staleTimer = [...h.clock.timers.values()][0]!;
	await h.emit("session_shutdown", { reason: "reload" });
	expect(h.clock.timers.size).toBe(0);
	staleTimer.callback();
	expect(h.continuations()).toHaveLength(0);
	await h.emit("session_start");
	h.clock.advance(5 * 60_000);
	expect(h.continuations()).toHaveLength(1);
	expect(h.goal().usageRetry.attempt).toBe(2);
});

test("restores legacy usage-limited goals without retry metadata", async () => {
	const h = createHarness(savedGoal({ usageRetry: undefined }));
	await h.emit("session_start");
	expect(h.goal().usageRetry).toEqual({ attempt: 1, retryAt: NOW + 5 * 60_000 });
	h.clock.advance(5 * 60_000);
	expect(h.continuations()).toHaveLength(1);
});

test("recovers an overdue retry interrupted after switching the goal active", async () => {
	const h = createHarness(savedGoal({ status: "active", usageRetry: { attempt: 3, retryAt: NOW - 1_000 } }));
	await h.emit("session_start");
	h.clock.advance(1);
	expect(h.continuations()).toHaveLength(1);
	expect(h.goal().usageRetry.attempt).toBe(3);
});

test("tree navigation and session replacement cannot deliver stale retries", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.limited();
	const staleTimer = [...h.clock.timers.values()][0]!;
	h.branch.splice(0);
	await h.emit("session_tree");
	staleTimer.callback();
	expect(h.clock.timers.size).toBe(0);
	await h.command("another goal");
	await h.limited();
	h.state.sessionId = "session-2";
	h.clock.advance(5 * 60_000);
	expect(h.continuations()).toHaveLength(2);
});

test("objective edits retain retry timing and deliver only the updated objective", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.limited();
	await h.command("edit");
	expect(h.clock.timers.size).toBe(1);
	h.clock.advance(5 * 60_000);
	expect(h.continuations()[1]!.content).toContain("edited objective");
	expect(h.continuations()[1]!.content).not.toContain("ship it");
});

test("provider reset hints do not overflow the native timer delay", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.limited("Monthly usage limit reached. Retry after 35 days.");
	expect([...h.clock.timers.values()][0]!.at).toBe(NOW + 2_147_483_647);
	h.clock.advance(2_147_483_647);
	expect(h.continuations()).toHaveLength(1);
	h.clock.advance(35 * 86_400_000 + 30_000 - 2_147_483_647);
	expect(h.continuations()).toHaveLength(2);
});

test("budget exhaustion takes priority over quota retry", async () => {
	const h = createHarness();
	await h.tool("create_goal", { objective: "ship it", token_budget: 100 });
	await h.start();
	await h.end("Usage limit reached", 100);
	await h.settle();
	expect(h.goal().status).toBe("budgetLimited");
	expect(h.clock.timers.size).toBe(0);
	h.clock.advance(86_400_000);
	expect(h.continuations()).toHaveLength(1);
});

test("restored retries cannot bypass an already exhausted token budget", async () => {
	const h = createHarness(savedGoal({ tokenBudget: 10 }));
	await h.emit("session_start");
	h.clock.advance(5 * 60_000);
	expect(h.goal().status).toBe("budgetLimited");
	expect(h.continuations()).toHaveLength(0);
});

for (const error of ["Context limit exceeded", "429 insufficient_quota: billing", "Invalid API key"]) {
	test(`${error} blocks instead of retrying indefinitely`, async () => {
		const h = createHarness();
		await h.command("ship it");
		await h.limited(error);
		expect(h.goal().status).toBe("blocked");
		expect(h.clock.timers.size).toBe(0);
	});
}

test("noninteractive quota retries do not require a dialog", async () => {
	const h = createHarness();
	(h.ctx as { hasUI: boolean }).hasUI = false;
	await h.command("ship it");
	await h.limited();
	h.clock.advance(5 * 60_000);
	expect(h.continuations()).toHaveLength(2);
});

test("aborting a retried turn can pause and cancel automatic work", async () => {
	const h = createHarness();
	await h.command("ship it");
	await h.limited();
	h.clock.advance(5 * 60_000);
	await h.start();
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
	await h.settle();
	expect(h.goal().status).toBe("paused");
	expect(h.goal().usageRetry).toBeUndefined();
	expect(h.clock.timers.size).toBe(0);
});
