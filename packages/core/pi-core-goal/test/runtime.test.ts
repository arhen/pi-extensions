import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import goalExtension from "../src/index.ts";

async function createRuntime(baseDelayMs = 1) {
	const dir = mkdtempSync(join(tmpdir(), "goal-runtime-"));
	const agentDir = join(dir, "agent");
	const modelRuntime = await ModelRuntime.create();
	const faux = fauxProvider({ models: [{ id: "goal-test", name: "Goal test" }] });
	modelRuntime.registerNativeProvider(faux.provider);
	const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir, extensionFactories: [goalExtension] });
	await resourceLoader.reload();
	const manager = SessionManager.inMemory(dir);
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir,
		modelRuntime,
		model: faux.getModel(),
		resourceLoader,
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory({
			defaultTools: [],
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 1, baseDelayMs },
		}),
	});
	await session.bindExtensions({});
	const realNow = Date.now.bind(Date);
	const realSetTimeout = globalThis.setTimeout.bind(globalThis);
	let offset = 0;
	const timers = new Map<object, { callback: () => void; delay: number }>();
	const nowSpy = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
	const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
		if (delay < 60_000) return realSetTimeout(callback, delay);
		const handle = { unref: () => handle };
		timers.set(handle, { callback, delay });
		return handle;
	}) as unknown as typeof setTimeout);
	const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
	const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((handle: any) => {
		if (!timers.delete(handle)) realClearTimeout(handle);
	}) as typeof clearTimeout);
	function goal(): any {
		const entries = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "goal");
		return (entries.at(-1) as { data?: { goal?: unknown } } | undefined)?.data?.goal;
	}
	return {
		session,
		faux,
		goal,
		timers,
		async waitFor(predicate: () => boolean) {
			const deadline = realNow() + 5_000;
			while (!predicate()) {
				if (realNow() > deadline) throw new Error(`Runtime timed out: ${JSON.stringify(goal())}`);
				await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
			}
		},
		fireRetry() {
			const next = [...timers][0];
			if (!next) throw new Error("No goal retry queued");
			offset += next[1].delay + 1;
			timers.delete(next[0]);
			next[1].callback();
		},
		async cleanup() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			nowSpy.mockRestore();
			timerSpy.mockRestore();
			clearSpy.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("real Pi session retries quota failures until the goal completes without more user input", async () => {
	const h = await createRuntime();
	try {
		h.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "GoUsageLimitError: Weekly usage limit reached" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "GoUsageLimitError: Weekly usage limit reached" }),
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })]),
			fauxAssistantMessage("Goal completed"),
		]);
		await h.session.prompt("/goal ship it");
		await h.waitFor(() => h.goal()?.status === "usageLimited" && h.session.isIdle);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.goal().usageRetry.attempt).toBe(1);
		expect(h.timers.size).toBe(1);
		h.fireRetry();
		await h.waitFor(() => h.goal()?.status === "usageLimited" && h.session.isIdle);
		expect(h.faux.state.callCount).toBe(2);
		expect(h.goal().usageRetry.attempt).toBe(2);
		h.fireRetry();
		await h.waitFor(() => h.goal()?.status === "complete" && h.session.isIdle);
		expect(h.faux.state.callCount).toBe(4);
		expect(h.timers.size).toBe(0);
		expect(h.goal().usageRetry).toBeUndefined();
	} finally {
		await h.cleanup();
	}
}, 15_000);

test("real fire-and-forget API recovers repeated rejected continuation starts without user input", async () => {
	const h = await createRuntime();
	const prompt: (...args: any[]) => Promise<void> = h.session.agent.prompt.bind(h.session.agent);
	let failures = 2;
	const sender = spyOn(h.session.agent, "prompt").mockImplementation(async (...args) => {
		if (failures > 0) {
			failures--;
			throw new Error("Cannot submit a prompt while compaction is in progress");
		}
		await prompt(...args);
	});
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })]),
			fauxAssistantMessage("Goal completed"),
		]);
		await h.session.prompt("/goal ship it");
		await h.waitFor(() => failures === 1 && h.timers.size === 1 && h.session.isIdle);
		expect(h.faux.state.callCount).toBe(0);
		h.fireRetry();
		await h.waitFor(() => failures === 0 && h.timers.size === 1 && h.session.isIdle);
		expect(h.faux.state.callCount).toBe(0);
		h.fireRetry();
		await h.waitFor(() => h.goal()?.status === "complete" && h.session.isIdle);
		expect(h.faux.state.callCount).toBe(2);
		expect(h.timers.size).toBe(0);
	} finally {
		sender.mockRestore();
		await h.cleanup();
	}
}, 15_000);

test("real Pi native rate-limit recovery succeeds without scheduling a stale quota retry", async () => {
	const h = await createRuntime();
	try {
		h.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })]),
			fauxAssistantMessage("Goal completed"),
		]);
		await h.session.prompt("/goal ship it");
		await h.waitFor(() => h.goal()?.status === "complete" && h.session.isIdle);
		expect(h.faux.state.callCount).toBe(3);
		expect(h.timers.size).toBe(0);
		expect(h.goal().usageRetry).toBeUndefined();
	} finally {
		await h.cleanup();
	}
}, 15_000);

test("real Pi abort during native retry backoff pauses instead of scheduling quota recovery", async () => {
	const h = await createRuntime(30_000);
	try {
		h.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" })]);
		await h.session.prompt("/goal ship it");
		await h.waitFor(() => h.session.isRetrying);
		await h.session.abort();
		expect(h.goal().status).toBe("paused");
		expect(h.timers.size).toBe(0);
		expect(h.faux.state.callCount).toBe(1);
	} finally {
		await h.cleanup();
	}
}, 15_000);

test("real Pi schedules one quota retry only after native rate-limit retries are exhausted", async () => {
	const h = await createRuntime();
	try {
		h.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
		]);
		await h.session.prompt("/goal ship it");
		await h.waitFor(() => h.goal()?.status === "usageLimited" && h.session.isIdle);
		expect(h.faux.state.callCount).toBe(2);
		expect(h.goal().usageRetry.attempt).toBe(1);
		expect(h.timers.size).toBe(1);
		await h.session.prompt("/goal pause");
		expect(h.timers.size).toBe(0);
	} finally {
		await h.cleanup();
	}
}, 15_000);
