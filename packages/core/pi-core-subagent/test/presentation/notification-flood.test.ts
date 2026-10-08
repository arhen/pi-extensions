import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { isolateAgentDir } from "./agent-dir.ts";
import { createRuntimeHarness, type RuntimeHarness } from "./runtime-harness.ts";

/**
 * Held notices released at one boundary must reach the leader once each, even when every leader
 * turn takes real LLM time. Pi serializes prompts submitted during `agent_settled`, so later
 * notices sit in its deferred queue while the first one's turn runs.
 */
const fakeHome = mkdtempSync(join(tmpdir(), "subagent-flood-home-"));
const agentDir = isolateAgentDir();
const originalHome = process.env.HOME;
beforeAll(() => {
	process.env.HOME = fakeHome;
});
afterAll(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(fakeHome, { recursive: true, force: true });
	agentDir.restore();
});

interface AnyMessage {
	role?: string;
	toolName?: string;
	content?: unknown;
}
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function messageText(message: AnyMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content === undefined ? "" : JSON.stringify(message.content);
}
function hasToolResult(messages: AnyMessage[], name: string): boolean {
	return messages.some((m) => m.role === "toolResult" && m.toolName === name);
}
function isChildRequest(context: unknown): boolean {
	return JSON.stringify((context as { messages: unknown }).messages).includes("You are running as a subagent");
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve once the leader transcript has stopped growing for `quietMs`. */
async function quiesce(h: RuntimeHarness, quietMs: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = -1;
	let stableSince = Date.now();
	while (Date.now() < deadline) {
		const size = h.session.messages.length;
		if (size !== last) {
			last = size;
			stableSince = Date.now();
		} else if (!h.session.isStreaming && Date.now() - stableSince >= quietMs) return;
		await sleep(100);
	}
}

describe("held notices under realistic leader latency", () => {
	test("each final report reaches the leader exactly once", async () => {
		let release: () => void = () => {};
		const finished = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = await createRuntimeHarness({
			codemode: false,
			extensions: [(pi) => pi.events.on("subagent:run-completed", release)],
		});
		cleanups.push(h.cleanup);
		const LEADER_TURN_MS = 3_500;
		h.faux.setResponses(
			Array.from({ length: 40 }, () => async (context: TranscriptContext) => {
				const messages = (context as { messages: AnyMessage[] }).messages;
				if (isChildRequest(context)) {
					const n = JSON.stringify(messages).includes("flood-fixture-1")
						? 1
						: JSON.stringify(messages).includes("flood-fixture-2")
							? 2
							: 3;
					if (!hasToolResult(messages, "notify_parent"))
						return fauxAssistantMessage([fauxToolCall("notify_parent", { message: `REPORT_${n}`, final: true })]);
					return fauxAssistantMessage(`REPORT_${n}`);
				}
				if (!hasToolResult(messages, "subagent"))
					return fauxAssistantMessage([
						fauxToolCall("subagent", {
							tasks: [1, 2, 3].map((n) => ({ agent: `worker-${n}`, task: `flood-fixture-${n}` })),
						}),
					]);
				// The leader is busy (a long turn) while every child finishes, so all reports are held.
				await finished;
				await sleep(LEADER_TURN_MS);
				return fauxAssistantMessage("ACK");
			}),
		);
		await h.session.prompt("delegate three reporting workers");
		await quiesce(h, 8_000, 90_000);

		const notices = (h.session.messages as AnyMessage[])
			.filter((m) => m.role === "user")
			.map(messageText)
			.filter((text) => /REPORT_\d/.test(text));
		const count = (n: number) => notices.filter((text) => text.includes(`REPORT_${n}`)).length;
		const turns = (h.session.messages as AnyMessage[]).filter((m) => m.role === "assistant").length;
		expect([count(1), count(2), count(3)]).toEqual([1, 1, 1]);
		// All three held reports leave in one message: one extra leader turn, not one per report.
		expect(notices).toHaveLength(1);
		expect(turns).toBe(3);
	}, 120_000);

	test("reports the leader already read with subagent_result are not delivered later", async () => {
		let release: () => void = () => {};
		const finished = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = await createRuntimeHarness({
			codemode: false,
			extensions: [(pi) => pi.events.on("subagent:run-completed", release)],
		});
		cleanups.push(h.cleanup);
		h.faux.setResponses(
			Array.from({ length: 40 }, () => async (context: TranscriptContext) => {
				const messages = (context as { messages: AnyMessage[] }).messages;
				if (isChildRequest(context)) {
					const n = JSON.stringify(messages).includes("read-fixture-1") ? 1 : 2;
					if (!hasToolResult(messages, "notify_parent"))
						return fauxAssistantMessage([fauxToolCall("notify_parent", { message: `READ_${n}`, final: true })]);
					return fauxAssistantMessage(`READ_${n}`);
				}
				if (!hasToolResult(messages, "subagent"))
					return fauxAssistantMessage([
						fauxToolCall("subagent", {
							tasks: [1, 2].map((n) => ({ agent: `reader-${n}`, task: `read-fixture-${n}` })),
						}),
					]);
				if (!hasToolResult(messages, "subagent_result")) {
					await finished;
					const spawned = messages.find((m) => m.role === "toolResult" && m.toolName === "subagent");
					const runId = /run_[a-z0-9]+_[a-z0-9]+/.exec(messageText(spawned ?? {}))?.[0] ?? "";
					return fauxAssistantMessage([fauxToolCall("subagent_result", { runId })]);
				}
				await sleep(1_000);
				return fauxAssistantMessage("MERGED");
			}),
		);
		await h.session.prompt("delegate two readers, then read their results");
		await quiesce(h, 5_000, 60_000);

		const notices = (h.session.messages as AnyMessage[])
			.filter((m) => m.role === "user")
			.map(messageText)
			.filter((text) => /READ_\d/.test(text));
		expect(notices).toEqual([]);
	}, 90_000);
});
