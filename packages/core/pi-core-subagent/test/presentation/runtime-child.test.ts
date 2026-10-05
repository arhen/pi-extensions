import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { BASELINE_OPERATIONS } from "../parity/harness.ts";
import { createRuntimeHarness, type RuntimeHarness } from "./runtime-harness.ts";

/**
 * Child lifecycle tests drive real child sessions through the native Pi pipeline with the faux
 * provider. Children are created by the manager with the real agent dir (derived from HOME), so
 * HOME is redirected to a temp dir for this file to keep session files out of the user's home.
 */
const fakeHome = mkdtempSync(join(tmpdir(), "subagent-runtime-home-"));
const originalHome = process.env.HOME;
beforeAll(() => {
	process.env.HOME = fakeHome;
});
afterAll(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(fakeHome, { recursive: true, force: true });
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

async function harness(options: Parameters<typeof createRuntimeHarness>[0] = {}): Promise<RuntimeHarness> {
	const created = await createRuntimeHarness(options);
	cleanups.push(created.cleanup);
	return created;
}

function messageText(message: AnyMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content === undefined ? "" : JSON.stringify(message.content);
}

/** Text of the last tool result for `name`, newest first. */
function lastToolResult(messages: AnyMessage[], name: string): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "toolResult" && message.toolName === name) return messageText(message);
	}
	return undefined;
}

/** Index of the last tool result for `name`, or -1. */
function lastToolResultIndex(messages: AnyMessage[], name: string): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "toolResult" && message.toolName === name) return index;
	}
	return -1;
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("waitFor timed out");
}

function runIdIn(text: string | undefined): string {
	const runId = text ? /run_[a-z0-9]+_[a-z0-9]+/.exec(text)?.[0] : undefined;
	if (!runId) throw new Error(`no run id in tool result: ${text}`);
	return runId;
}

function isChildRequest(context: unknown): boolean {
	return JSON.stringify((context as { messages: unknown }).messages).includes("You are running as a subagent");
}

function contextMessages(context: unknown): AnyMessage[] {
	return (context as { messages: AnyMessage[] }).messages;
}

function exposuresOf(h: RuntimeHarness): string[] {
	return h.session
		.getAllTools()
		.filter((tool) => (BASELINE_OPERATIONS as readonly string[]).includes(tool.name))
		.map((tool) => tool.exposure);
}

async function prime(
	h: RuntimeHarness,
	count: number,
	factory: (context: TranscriptContext, index: number) => AssistantMessage,
): Promise<void> {
	h.faux.setResponses(
		Array.from({ length: count }, (_unused, index) => (context: TranscriptContext) => factory(context, index)),
	);
}

describe("native notification deduplication", () => {
	test.each([true, false])(
		"two queued final reports cause no completion echo (notifyPerTask: %p)",
		async (notifyPerTask) => {
			let release: () => void = () => {};
			const finished = new Promise<void>((resolve) => {
				release = resolve;
			});
			const h = await harness({
				codemode: false,
				extensions: [
					(pi) => {
						pi.events.on("subagent:run-completed", release);
					},
				],
			});
			h.faux.setResponses(
				Array.from({ length: 24 }, () => async (context: TranscriptContext) => {
					const messages = contextMessages(context);
					if (isChildRequest(context)) {
						const report = JSON.stringify(messages).includes("notify-fixture-1") ? "RESULT_1" : "RESULT_2";
						if (!lastToolResult(messages, "notify_parent"))
							return fauxAssistantMessage([fauxToolCall("notify_parent", { message: report, final: true })]);
						return fauxAssistantMessage(report);
					}
					if (!lastToolResult(messages, "subagent"))
						return fauxAssistantMessage([
							fauxToolCall("subagent", {
								tasks: [
									{ agent: "worker-1", task: "notify-fixture-1" },
									{ agent: "worker-2", task: "notify-fixture-2" },
								],
								notifyPerTask,
							}),
						]);
					await finished;
					return fauxAssistantMessage("PARENT_DONE");
				}),
			);
			await h.session.prompt("delegate two reporting workers");
			await new Promise((resolve) => setTimeout(resolve, 150));
			const notices = (h.session.messages as AnyMessage[]).filter(
				(m) => m.role === "user" && /Subagent|Task worker|Background subagent/.test(messageText(m)),
			);
			expect(notices).toHaveLength(2);
			expect(notices.filter((m) => messageText(m).includes("RESULT_1"))).toHaveLength(1);
			expect(notices.filter((m) => messageText(m).includes("RESULT_2"))).toHaveLength(1);
		},
		60_000,
	);

	test("duplicate progress across both talk tools arrives once, with completion retained", async () => {
		let release: () => void = () => {};
		const finished = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = await harness({
			codemode: false,
			extensions: [
				(pi) => {
					pi.events.on("subagent:run-completed", release);
				},
			],
		});
		h.faux.setResponses(
			Array.from({ length: 32 }, () => async (context: TranscriptContext) => {
				const messages = contextMessages(context);
				if (isChildRequest(context)) {
					if (!lastToolResult(messages, "notify_parent"))
						return fauxAssistantMessage([fauxToolCall("notify_parent", { message: "PROGRESS_QZX" })]);
					if (!lastToolResult(messages, "send_agent_message"))
						return fauxAssistantMessage([
							fauxToolCall("send_agent_message", { to: "leader", message: "PROGRESS_QZX" }),
						]);
					return fauxAssistantMessage("COMPLETED_QZX");
				}
				if (!lastToolResult(messages, "subagent"))
					return fauxAssistantMessage([fauxToolCall("subagent", { agent: "reporter", task: "report" })]);
				await finished;
				return fauxAssistantMessage("PARENT_DONE");
			}),
		);
		await h.session.prompt("delegate a progress reporter");
		await new Promise((resolve) => setTimeout(resolve, 150));
		const notices = (h.session.messages as AnyMessage[]).filter(
			(m) => m.role === "user" && /Subagent|Task reporter|Background subagent/.test(messageText(m)),
		);
		expect(notices).toHaveLength(2);
		expect(notices.filter((m) => messageText(m).includes("PROGRESS_QZX"))).toHaveLength(1);
		expect(notices.filter((m) => messageText(m).includes("COMPLETED_QZX"))).toHaveLength(1);
	}, 60_000);

	test("a report stripped from the leader transcript falls back exactly once", async () => {
		let release: () => void = () => {};
		const finished = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = await harness({
			codemode: false,
			extensions: [
				(pi) => {
					pi.events.on("subagent:run-completed", release);
					pi.on("message_end", (event) => {
						if (
							event.message.role === "user" &&
							messageText(event.message).startsWith('[{"type":"text","text":"[Subagent')
						) {
							return { message: { ...event.message, content: [{ type: "text", text: "REDACTED" }] } };
						}
					});
				},
			],
		});
		h.faux.setResponses(
			Array.from({ length: 32 }, () => async (context: TranscriptContext) => {
				const messages = contextMessages(context);
				if (isChildRequest(context)) {
					if (!lastToolResult(messages, "notify_parent"))
						return fauxAssistantMessage([
							fauxToolCall("notify_parent", { message: "STRIPPED_REPORT_QZX", final: true }),
						]);
					return fauxAssistantMessage("STRIPPED_REPORT_QZX");
				}
				if (!lastToolResult(messages, "subagent"))
					return fauxAssistantMessage([fauxToolCall("subagent", { agent: "reporter", task: "report" })]);
				await finished;
				return fauxAssistantMessage("PARENT_DONE");
			}),
		);
		await h.session.prompt("delegate a final reporter");
		const notices = () =>
			(h.session.messages as AnyMessage[]).filter((m) => m.role === "user" && messageText(m).includes("Task reporter"));
		await waitFor(() => notices().some((m) => messageText(m).includes("STRIPPED_REPORT_QZX")), 25_000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(notices()).toHaveLength(1);
		expect(messageText(notices()[0]!)).toContain("STRIPPED_REPORT_QZX");
	}, 60_000);

	test("autoAwait retains final reports outside a truncated run summary", async () => {
		const h = await harness({ codemode: false });
		h.faux.setResponses(
			Array.from({ length: 40 }, () => (context: TranscriptContext) => {
				const messages = contextMessages(context);
				if (isChildRequest(context)) {
					const report = JSON.stringify(messages).includes("wide-report-qzx")
						? `FIRST_${"x".repeat(24 * 1024 - 6)}`
						: "LATE_REPORT_QZX";
					if (!lastToolResult(messages, "notify_parent"))
						return fauxAssistantMessage([fauxToolCall("notify_parent", { message: report, final: true })]);
					return fauxAssistantMessage(report);
				}
				if (!lastToolResult(messages, "subagent"))
					return fauxAssistantMessage([
						fauxToolCall("subagent", {
							tasks: [
								{ agent: "wide", task: "wide-report-qzx" },
								{ agent: "late", task: "late-report-qzx" },
							],
							concurrency: 1,
							autoAwait: true,
						}),
					]);
				return fauxAssistantMessage("PARENT_DONE");
			}),
		);
		await h.session.prompt("delegate two final reporters");
		const result = lastToolResult(h.session.messages as AnyMessage[], "subagent") ?? "";
		expect(result.match(/LATE_REPORT_QZX/g)).toHaveLength(1);
	}, 60_000);

	test("autoAwait returns final report text once, without a parked done echo", async () => {
		const h = await harness({ codemode: false });
		await prime(h, 12, (context) => {
			const messages = contextMessages(context);
			if (isChildRequest(context)) {
				if (!lastToolResult(messages, "notify_parent"))
					return fauxAssistantMessage([fauxToolCall("notify_parent", { message: "FINAL_REPORT_QZX", final: true })]);
				return fauxAssistantMessage("FINAL_REPORT_QZX");
			}
			if (!lastToolResult(messages, "subagent"))
				return fauxAssistantMessage([fauxToolCall("subagent", { agent: "reporter", task: "report", autoAwait: true })]);
			return fauxAssistantMessage("PARENT_DONE");
		});
		await h.session.prompt("await a reporting worker");
		const result = lastToolResult(h.session.messages as AnyMessage[], "subagent") ?? "";
		expect(result.match(/FINAL_REPORT_QZX/g)).toHaveLength(1);
		expect(
			(h.session.messages as AnyMessage[]).filter(
				(m) => m.role === "user" && /Subagent|Task reporter|Background subagent/.test(messageText(m)),
			),
		).toHaveLength(0);
	}, 60_000);
});

describe("real child lifecycle over the native pipeline", () => {
	test("background run: spawn, await, result and session file", async () => {
		const h = await harness({ codemode: false });
		await prime(h, 12, (context) => {
			if (isChildRequest(context)) return fauxAssistantMessage("CHILD_OK");
			const messages = contextMessages(context);
			const subagent = lastToolResult(messages, "subagent");
			if (!subagent) return fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "say done" })]);
			const runId = runIdIn(subagent);
			const awaited = lastToolResult(messages, "await_subagent");
			if (!awaited) return fauxAssistantMessage([fauxToolCall("await_subagent", { runId })]);
			return fauxAssistantMessage([fauxToolCall("subagent_result", { runId })]);
		});

		await h.session.prompt("delegate and await");

		const result = lastToolResult(h.session.messages as AnyMessage[], "subagent_result") ?? "";
		expect(result).toContain("CHILD_OK");
		expect(result).toContain("completed");
		expect(result).not.toContain("Branch:");
		expect(lastToolResult(h.session.messages as AnyMessage[], "await_subagent")?.match(/CHILD_OK/g)).toHaveLength(1);

		const status = lastToolResult(h.session.messages as AnyMessage[], "subagent") ?? "";
		expect(status).toContain("Background run started");
	}, 60_000);

	test("autoAwait returns the child result inline without a separate await", async () => {
		const h = await harness({ codemode: false });
		await prime(h, 12, (context) => {
			if (isChildRequest(context)) return fauxAssistantMessage("AUTO_OK");
			return fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "auto", autoAwait: true })]);
		});

		await h.session.prompt("delegate");

		const result = lastToolResult(h.session.messages as AnyMessage[], "subagent") ?? "";
		expect(result).toContain("AUTO_OK");
		expect(result.match(/AUTO_OK/g)).toHaveLength(1);
		expect(result).toMatch(/succeeded|completed/);
	}, 60_000);
});

describe("intercom on a live child", () => {
	test("ask parks the child, reply resumes it, and the await result carries the answer", async () => {
		const h = await harness({ codemode: false });
		let childTurn = 0;
		await prime(h, 16, (context) => {
			if (isChildRequest(context)) {
				childTurn++;
				if (childTurn === 1)
					return fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Which file should I touch?" })]);
				return fauxAssistantMessage("CHILD_REPLIED");
			}
			const messages = contextMessages(context);
			const subagent = lastToolResult(messages, "subagent");
			if (!subagent) return fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "ask" })]);
			const runId = runIdIn(subagent);
			const awaited = lastToolResult(messages, "await_subagent");
			const replied = lastToolResultIndex(messages, "reply_subagent") > lastToolResultIndex(messages, "await_subagent");
			if (!awaited) return fauxAssistantMessage([fauxToolCall("await_subagent", { runId })]);
			if (awaited.includes("Which file") && !replied)
				return fauxAssistantMessage([
					fauxToolCall("reply_subagent", { runId, taskId: "task_1", message: "src/index.ts" }),
				]);
			return fauxAssistantMessage([fauxToolCall("await_subagent", { runId })]);
		});

		await h.session.prompt("delegate and answer");
		await waitFor(() => JSON.stringify(h.session.messages).includes("CHILD_REPLIED"));

		const asks = (h.session.messages as AnyMessage[]).filter(
			(message) =>
				message.role === "toolResult" &&
				message.toolName === "await_subagent" &&
				messageText(message).includes("Which file"),
		);
		expect(asks).toHaveLength(1);
		const finals = (h.session.messages as AnyMessage[]).filter(
			(message) =>
				message.role === "toolResult" &&
				message.toolName === "await_subagent" &&
				messageText(message).includes("CHILD_REPLIED"),
		);
		expect(finals.length).toBeGreaterThan(0);
	}, 60_000);

	test("steer reaches a child parked on ask_parent before the reply resumes it", async () => {
		const h = await harness({ codemode: false });
		let childTurn = 0;
		await prime(h, 20, (context) => {
			if (isChildRequest(context)) {
				childTurn++;
				if (childTurn === 1) return fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Hold on?" })]);
				const sawSteer = JSON.stringify(contextMessages(context)).includes("STEER_MARKER");
				return fauxAssistantMessage(sawSteer ? "CHILD_STEERED" : "CHILD_WITHOUT_STEER");
			}
			const messages = contextMessages(context);
			const subagent = lastToolResult(messages, "subagent");
			if (!subagent) return fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "steer" })]);
			const runId = runIdIn(subagent);
			const awaited = lastToolResult(messages, "await_subagent");
			const steered = lastToolResult(messages, "steer_subagent");
			const replied = lastToolResult(messages, "reply_subagent");
			if (!awaited) return fauxAssistantMessage([fauxToolCall("await_subagent", { runId })]);
			if (!steered && awaited.includes("Hold on"))
				return fauxAssistantMessage([
					fauxToolCall("steer_subagent", { runId, taskId: "task_1", message: "STEER_MARKER" }),
				]);
			if (!replied)
				return fauxAssistantMessage([fauxToolCall("reply_subagent", { runId, taskId: "task_1", message: "yes" })]);
			return fauxAssistantMessage([fauxToolCall("await_subagent", { runId })]);
		});

		await h.session.prompt("delegate, steer, reply");

		const result = await h.session.messages;
		expect(JSON.stringify(result)).toContain("CHILD_STEERED");
		expect(JSON.stringify(result)).not.toContain("CHILD_WITHOUT_STEER");
	}, 60_000);
});

describe("cancellation and recovery on a real child", () => {
	test("subagent_cancel aborts a parked run and the terminal state is observable", async () => {
		const h = await harness({ codemode: false });
		await prime(h, 16, (context) => {
			if (isChildRequest(context)) return fauxAssistantMessage([fauxToolCall("ask_parent", { question: "waiting" })]);
			const messages = contextMessages(context);
			const subagent = lastToolResult(messages, "subagent");
			if (!subagent) return fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "cancel me" })]);
			const runId = runIdIn(subagent);
			const canceled = lastToolResult(messages, "subagent_cancel");
			if (!canceled) return fauxAssistantMessage([fauxToolCall("subagent_cancel", { runId })]);
			const result = lastToolResult(messages, "subagent_result");
			if (!result) return fauxAssistantMessage([fauxToolCall("subagent_result", { runId })]);
			return fauxAssistantMessage("PARENT_DONE");
		});

		await h.session.prompt("delegate and cancel");

		const canceled = lastToolResult(h.session.messages as AnyMessage[], "subagent_cancel") ?? "";
		expect(canceled).toContain("Canceled 1 task");

		const result = lastToolResult(h.session.messages as AnyMessage[], "subagent_result") ?? "";
		expect(result).toContain("aborted");

		// The abort notice is sent after the background run's completion emit; waiting for it keeps
		// the harness alive until the run has fully settled.
		await waitFor(() =>
			(h.session.messages as AnyMessage[]).some(
				(message) => message.role === "user" && messageText(message).includes("aborted"),
			),
		);
	}, 60_000);

	test("a failed task keeps its session file and resume revives it to completion", async () => {
		const h = await harness({ codemode: false });
		let childTurn = 0;
		await prime(h, 20, (context) => {
			if (isChildRequest(context)) {
				childTurn++;
				if (childTurn === 1)
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "faux provider exploded" });
				return fauxAssistantMessage("CHILD_RECOVERED");
			}
			const messages = contextMessages(context);
			const subagent = lastToolResult(messages, "subagent");
			if (!subagent)
				return fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "fail then resume" })]);
			const runId = runIdIn(subagent);
			const awaited = lastToolResult(messages, "await_subagent");
			const resumed =
				lastToolResultIndex(messages, "resume_subagent") > lastToolResultIndex(messages, "await_subagent");
			if (awaited?.includes("faux provider exploded") && !resumed)
				return fauxAssistantMessage([fauxToolCall("resume_subagent", { runId, taskId: "task_1" })]);
			if (!awaited || resumed) return fauxAssistantMessage([fauxToolCall("await_subagent", { runId })]);
			return fauxAssistantMessage("PARENT_DONE");
		});

		await h.session.prompt("delegate, fail, resume");
		await waitFor(() => JSON.stringify(h.session.messages).includes("CHILD_RECOVERED"));

		const messages = h.session.messages as AnyMessage[];
		const failed = messages.find(
			(message) =>
				message.role === "toolResult" &&
				message.toolName === "await_subagent" &&
				messageText(message).includes("faux provider exploded"),
		);
		expect(failed).toBeDefined();
		const resumed = lastToolResult(messages, "resume_subagent") ?? "";
		expect(resumed).toContain("Resumed");
		expect(JSON.stringify(messages)).toContain("CHILD_RECOVERED");
	}, 90_000);
});

describe("codemode and mode changes against a real child", () => {
	const NESTED_SCRIPT = `
let validation = null;
try {
  await tools.subagent({ task: "missing agent" });
} catch (error) {
  validation = String(error && error.message ? error.message : error);
}
const started = await tools.subagent({ agent: "nested", task: "spawn through codemode" });
const startedText = typeof started === "string" ? started : JSON.stringify(started);
const runId = (startedText.match(/run_[a-z0-9]+_[a-z0-9]+/) || [])[0] || null;
const awaited = runId ? await tools.await_subagent({ runId }) : null;
return {
  validation,
  runId,
  output: typeof awaited === "string" ? awaited : JSON.stringify(awaited),
};
`;

	test("nested codemode calls spawn, validate and await a real child", async () => {
		const h = await harness({ codemode: "on", inlineBudget: 3000 });
		await prime(h, 16, (context) => {
			if (isChildRequest(context)) return fauxAssistantMessage("NESTED_OK");
			const messages = contextMessages(context);
			const scripted = lastToolResult(messages, "codemode");
			if (!scripted) return fauxAssistantMessage([fauxToolCall("codemode", { code: NESTED_SCRIPT })]);
			return fauxAssistantMessage("PARENT_DONE");
		});

		await h.session.prompt("spawn through a script");

		const script = lastToolResult(h.session.messages as AnyMessage[], "codemode") ?? "";
		expect(script).toContain("Script completed");
		expect(script).toContain("NESTED_OK");
		expect(script).toMatch(/validation/i);
		expect(script).toMatch(/agent|required/i);
	}, 90_000);

	test("a live child survives a mode switch and still completes", async () => {
		const h = await harness({ codemode: "on", inlineBudget: 3000 });
		await h.session.prompt("/subagents mode auto");
		let childTurn = 0;
		await prime(h, 24, (context) => {
			if (isChildRequest(context)) {
				childTurn++;
				if (childTurn === 1) return fauxAssistantMessage([fauxToolCall("ask_parent", { question: "still there?" })]);
				return fauxAssistantMessage("SURVIVED_OK");
			}
			const messages = contextMessages(context);
			const subagent = lastToolResult(messages, "subagent");
			if (!subagent)
				return fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "survive a switch" })]);
			const runId = runIdIn(subagent);
			const awaited = lastToolResult(messages, "await_subagent");
			const replied = lastToolResultIndex(messages, "reply_subagent") > lastToolResultIndex(messages, "await_subagent");
			if (!awaited) return fauxAssistantMessage([fauxToolCall("await_subagent", { runId })]);
			if (awaited.includes("still there") && !replied)
				return fauxAssistantMessage([fauxToolCall("reply_subagent", { runId, taskId: "task_1", message: "yes" })]);
			return fauxAssistantMessage([fauxToolCall("await_subagent", { runId })]);
		});

		await h.session.prompt("delegate and pause");
		expect(exposuresOf(h)).toEqual(BASELINE_OPERATIONS.map(() => "deferred"));

		await h.session.prompt("/subagents mode direct");
		expect(exposuresOf(h)).toEqual(BASELINE_OPERATIONS.map(() => "direct"));

		await h.session.prompt("answer the child");
		await waitFor(() => JSON.stringify(h.session.messages).includes("SURVIVED_OK"));
		expect(JSON.stringify(h.session.messages)).toContain("SURVIVED_OK");
	}, 90_000);
});
