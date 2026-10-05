import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "../src/manager.ts";
import { textFingerprint } from "../src/notification-state.ts";
import type { RunSnapshot, TaskSnapshot } from "../src/types.ts";

type Kind = "completed" | "failed" | "aborted";
type Handlers = {
	onNotifyParent(taskId: string, message: string, level: "info" | "warning" | "error", final?: boolean): boolean;
	onSendMessage(taskId: string, to: string, message: string, final?: boolean): boolean;
};
type PrivateManager = {
	makeChildHandlers(run: RunSnapshot, task: TaskSnapshot, ctx: ExtensionContext): Handlers;
	notifyTask(run: RunSnapshot, task: TaskSnapshot, kind: Kind): void;
	notifyParent(run: RunSnapshot, kind: Kind): void;
	finishRunIfSettled(run: RunSnapshot, ctx: ExtensionContext): void;
	settleRun(runId: string, run: RunSnapshot): void;
	leaderMessages: Map<string, { submittedAt: number; lost: boolean; delivered: boolean; attempts: number }>;
	outbox: Map<string, unknown>;
	terminalNotices: Map<string, { body: string; delivery: string }>;
	pendingRunNotices: Map<string, unknown>;
};
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(count = 1, notifyPerTask = true) {
	const sent: Array<{ body: string; deliverAs?: string }> = [];
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	const canonical: Array<{ role: string; content: unknown }> = [];
	let fail = false;
	let idle = false;
	let queued = true;
	const pi = {
		events: {
			emit(type: string, payload: Record<string, unknown>) {
				events.push({ type, payload });
			},
		},
		sendUserMessage(body: string, options?: { deliverAs?: string }) {
			if (fail) {
				fail = false;
				throw new Error("parent unavailable");
			}
			sent.push({ body, deliverAs: options?.deliverAs });
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/tmp",
		hasUI: false,
		isIdle: () => idle,
		hasPendingMessages: () => queued,
		sessionManager: {
			buildSessionProjection: () => ({ messages: canonical }),
		},
	} as unknown as ExtensionContext;
	const manager = new SubagentManager(pi);
	cleanups.push(() => manager.clearRuns());
	const internals = manager as unknown as PrivateManager;
	const { run } = manager.createRun(
		{
			tasks: Array.from({ length: count }, (_value, i) => ({ agent: `worker-${i}`, task: "fixture-qzx-91" })),
			notifyPerTask,
		},
		ctx,
	);
	run.status = "running";
	for (const task of run.tasks) {
		task.status = "running";
		task.toolCalls = 1;
	}
	const handlers = (i = 0) => internals.makeChildHandlers(run, run.tasks[i]!, ctx);
	const end = (i = 0, finalText = "RESULT_OK", kind: Kind = "completed") => {
		const task = run.tasks[i]!;
		task.status = kind;
		task.finalText = finalText;
		if (notifyPerTask) internals.notifyTask(run, task, kind);
	};
	/** Append the delivered body to the canonical leader context, then confirm receipts. */
	const receive = (body = sent.at(-1)?.body ?? "") => {
		canonical.push({ role: "user", content: [{ type: "text", text: body }] });
		manager.confirmLeaderMessages(ctx);
	};
	const settle = () => {
		idle = true;
		queued = false;
		manager.flushPendingNotifications(ctx);
	};
	/** Simulate a transport loss: every outstanding receipt is old enough to fail the grace check. */
	const ageReceipts = (ms = 60_000) => {
		for (const receipt of internals.leaderMessages.values()) receipt.submittedAt = Date.now() - ms;
	};
	const loseReceipts = () => ageReceipts(60_000);
	/** Simulate the retry backoff expiring on every held notification. */
	const expireBackoff = () => {
		for (const [body, entry] of internals.outbox) internals.outbox.set(body, { ...(entry as object), attemptedAt: 0 });
	};
	/** One leader agent run started; a receipt may only be declared lost after a later run. */
	const runTurn = () => manager.noteAgentStart();
	return {
		manager,
		internals,
		ctx,
		run,
		sent,
		events,
		handlers,
		end,
		receive,
		flush: settle,
		loseReceipts,
		ageReceipts,
		expireBackoff,
		runTurn,
		failNext: () => {
			fail = true;
		},
	};
}

describe("leader notification deduplication", () => {
	test("a received final report suppresses task and aggregate success follow-ups", () => {
		const h = fixture(2);
		for (const [i, task] of h.run.tasks.entries()) {
			h.handlers(i).onNotifyParent(task.id, "RESULT_OK", "info", true);
			h.end(i);
		}
		h.flush();
		for (const body of h.sent.map((m) => m.body)) h.receive(body);
		h.internals.notifyParent(h.run, "completed");
		h.flush();
		expect(h.sent).toHaveLength(2);
		expect(h.sent.every((m) => m.body.includes("RESULT_OK"))).toBe(true);
	});

	test("an intact report inside an input wrapper still counts as received", () => {
		const h = fixture();
		h.handlers().onNotifyParent("task_1", "RESULT_OK", "info", true);
		h.end();
		h.flush();
		h.receive.call(null, `Envelope\n${h.sent[0]!.body}\nFooter`);
		h.internals.notifyParent(h.run, "completed");
		h.flush();
		expect(h.sent).toHaveLength(1);
	});

	test("a report absent from canonical context is retried, then falls back exactly once", () => {
		const h = fixture();
		h.handlers().onNotifyParent("task_1", "RESULT_OK", "info", true);
		h.end();
		h.flush();
		expect(h.sent).toHaveLength(1);
		for (let round = 0; round < 8; round++) {
			h.loseReceipts();
			h.runTurn();
			h.expireBackoff();
			h.flush();
		}
		expect(h.sent.length).toBeLessThanOrEqual(8); // 3 report attempts + 3 fallback attempts + aggregate retry
		expect(h.sent.at(-1)?.body).toContain("RESULT_OK");
		expect(h.internals.leaderMessages.size).toBe(0);
		const count = h.sent.length;
		h.flush();
		h.flush();
		expect(h.sent).toHaveLength(count);
	});

	test("a pending update is coalesced; a lost one is re-queued automatically", () => {
		const h = fixture();
		h.handlers().onNotifyParent("task_1", "PROGRESS_1", "warning");
		h.flush();
		expect(h.sent).toHaveLength(1);
		h.handlers().onNotifyParent("task_1", "PROGRESS_1", "warning");
		h.flush();
		expect(h.sent).toHaveLength(1);
		h.loseReceipts();
		h.runTurn();
		h.flush();
		h.expireBackoff();
		h.flush();
		expect(h.sent).toHaveLength(2);
		expect(h.sent[1]?.body).toContain("PROGRESS_1");
	});

	test("a report is not declared lost while no later agent run has started", () => {
		const h = fixture();
		h.handlers().onNotifyParent("task_1", "RESULT_OK", "info", true);
		h.end();
		h.flush();
		h.ageReceipts(4_000);
		h.flush();
		expect(h.sent).toHaveLength(1);
	});

	test("identical updates are submitted once across both leader message tools", () => {
		const h = fixture();
		h.handlers().onNotifyParent("task_1", "same finding", "info");
		h.handlers().onNotifyParent("task_1", "same finding", "info");
		h.handlers().onSendMessage("task_1", "leader", "same finding");
		h.flush();
		expect(h.sent).toHaveLength(1);
	});

	test("different content, levels, phases, tasks and runs are not deduplicated", () => {
		const h = fixture(2);
		h.handlers().onNotifyParent("task_1", "finding", "info");
		h.handlers().onNotifyParent("task_1", "finding 2", "info");
		h.handlers().onNotifyParent("task_1", "finding", "warning");
		h.handlers().onNotifyParent("task_1", "finding", "info", true);
		h.handlers(1).onNotifyParent("task_2", "finding", "info");
		h.flush();
		expect(h.sent).toHaveLength(5);
	});

	test("a terminal await suppresses a held completion echo", async () => {
		const h = fixture();
		h.handlers().onNotifyParent("task_1", "RESULT_OK", "info", true);
		h.end();
		h.run.status = "completed";
		await h.manager.awaitRun(h.run.id);
		h.manager.markAwaitCoverage(h.run, new Set(["task_1"]));
		h.flush();
		expect(h.sent).toHaveLength(0);
	});

	test("a failed task steers once; its aggregate does not repeat the same outcome", () => {
		const h = fixture();
		h.run.tasks[0]!.error = "ONE_OUTCOME";
		h.end(0, "PARTIAL", "failed");
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.deliverAs).toBe("steer");
		h.run.status = "failed";
		h.internals.notifyParent(h.run, "failed");
		h.flush();
		expect(h.sent).toHaveLength(1);
	});

	test("a new failure after a delivered success report stays visible", () => {
		const h = fixture();
		h.handlers().onNotifyParent("task_1", "RESULT_OK", "info", true);
		h.end();
		h.flush();
		h.receive();
		h.run.tasks[0]!.error = "new problem";
		h.run.tasks[0]!.status = "failed";
		h.end(0, "RESULT_OK", "failed");
		expect(h.sent).toHaveLength(2);
		expect(h.sent[1]?.deliverAs).toBe("steer");
		expect(h.sent[1]?.body).toContain("new problem");
	});

	test("an aborted run with a task notice sends no duplicate aggregate", () => {
		const h = fixture();
		h.end(0, "PARTIAL", "aborted");
		h.flush();
		h.run.status = "aborted";
		h.internals.notifyParent(h.run, "aborted");
		h.flush();
		expect(h.sent).toHaveLength(1);
	});

	test("static isolation without a diff does not add an artifact notice", () => {
		const h = fixture();
		h.run.tasks[0]!.isolation = "in-place";
		h.handlers().onNotifyParent("task_1", "RESULT_OK", "info", true);
		h.end();
		h.flush();
		h.receive();
		h.flush();
		expect(h.sent).toHaveLength(1);
	});

	test("new committed changes after a report send an artifacts-only notice", () => {
		const h = fixture();
		h.handlers().onNotifyParent("task_1", "RESULT_OK", "info", true);
		Object.assign(h.run.tasks[0]!, {
			branch: "subagents/test",
			changedFiles: ["src/a.ts"],
			diffStat: "1 file changed",
		});
		h.end();
		h.flush();
		h.receive();
		h.flush();
		expect(h.sent).toHaveLength(2);
		expect(h.sent[1]?.body).toContain("subagents/test");
		expect(h.sent[1]?.body).not.toContain("RESULT_OK");
	});

	test("an identical final answer above the truncation cap does not echo", () => {
		const h = fixture();
		const report = "X".repeat(24 * 1024 + 512);
		h.handlers().onNotifyParent("task_1", report, "info", true);
		h.run.tasks[0]!.finalTextFingerprint = undefined;
		h.run.tasks[0]!.finalText = report;
		h.end(0, report);
		h.flush();
		h.receive();
		h.flush();
		expect(h.sent).toHaveLength(1);
	});

	test("aggregate-only mode reports only uncovered tasks", () => {
		const h = fixture(2, false);
		h.handlers().onNotifyParent("task_1", "RESULT_OK", "info", true);
		h.end(0);
		h.run.tasks[0]!.status = "completed";
		h.run.tasks[0]!.finalText = "RESULT_OK";
		h.end(1, "RESULT_1");
		h.internals.notifyParent(h.run, "completed");
		h.flush();
		expect(h.sent).toHaveLength(2);
		const aggregate = h.sent[1]!.body;
		expect(aggregate).toContain("worker-1");
		expect(aggregate).not.toContain("worker-0");
	});

	test("a failed submission stays queued and is not marked received", () => {
		const h = fixture();
		h.handlers().onNotifyParent("task_1", "RESULT_OK", "info", true);
		h.end();
		h.failNext();
		h.flush();
		expect(h.sent).toHaveLength(0);
		expect(h.internals.leaderMessages.size).toBe(0);
		h.expireBackoff();
		h.flush();
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.body).toContain("RESULT_OK");
	});
});

describe("review regressions", () => {
	test("R1: a delivered notice is not marked lost while its prompt is still queued", () => {
		const h = fixture(2);
		for (const task of h.run.tasks) h.handlers().onNotifyParent(task.id, "RESULT_OK", "info", true);
		for (const task of h.run.tasks) h.end(h.run.tasks.indexOf(task));
		h.flush();
		expect(h.sent).toHaveLength(2);
		h.receive(h.sent[0]!.body);
		h.ageReceipts(4_000);
		h.flush();
		expect(h.sent).toHaveLength(2);
	});

	test("R2: a lost final report falls back with its result, not a bare status line", () => {
		const h = fixture();
		h.handlers().onNotifyParent("task_1", "RESULT_OK", "info", true);
		h.end();
		h.flush();
		for (let attempt = 0; attempt < 3; attempt++) {
			h.loseReceipts();
			h.runTurn();
			h.flush();
			h.expireBackoff();
		}
		expect(h.sent.at(-1)?.body).toContain("RESULT_OK");
	});

	test("R3: an aggregate-only lost report still reaches the leader", () => {
		const h = fixture(1, false);
		h.handlers().onNotifyParent("task_1", "RESULT_OK", "info", true);
		h.end();
		h.run.status = "completed";
		h.internals.notifyParent(h.run, "completed");
		h.flush();
		for (let attempt = 0; attempt < 3; attempt++) {
			h.loseReceipts();
			h.runTurn();
			h.flush();
			h.expireBackoff();
		}
		expect(h.sent.some((message) => message.body.includes("RESULT_OK"))).toBe(true);
	});

	test("R4: a lost aborted aggregate is retried", () => {
		const h = fixture();
		h.end(0, "PARTIAL", "aborted");
		h.run.status = "aborted";
		h.internals.notifyParent(h.run, "aborted");
		h.flush();
		const first = h.sent.length;
		h.loseReceipts();
		h.runTurn();
		h.flush();
		h.expireBackoff();
		h.flush();
		expect(h.sent.length).toBeGreaterThan(first);
	});

	test("R5: the runChild truncation fingerprint does not defeat the match", () => {
		const h = fixture();
		const report = "Y".repeat(24 * 1024 + 64);
		h.run.tasks[0]!.finalTextFingerprint = textFingerprint(report);
		h.handlers().onNotifyParent("task_1", report, "info", true);
		h.run.tasks[0]!.finalText = `${report.slice(0, 24 * 1024)}\n\n[Output truncated]`;
		h.end(0, h.run.tasks[0]!.finalText);
		h.flush();
		h.receive();
		h.flush();
		expect(h.sent).toHaveLength(1);
	});

	test("R6: an await drops only tasks the rendered summary covered", async () => {
		const h = fixture(2);
		h.handlers(0).onNotifyParent("task_1", "RESULT_A", "info", true);
		h.handlers(1).onNotifyParent("task_2", "RESULT_B", "info", true);
		h.end(0);
		h.end(1);
		h.run.status = "completed";
		await h.manager.awaitRun(h.run.id);
		h.manager.markAwaitCoverage(h.run, new Set(["task_1"]));
		h.flush();
		const bodies = h.sent.map((message) => message.body);
		expect(bodies.some((body) => body.includes("RESULT_B"))).toBe(true);
	});

	test("R7: clearRuns clears held run fallbacks", () => {
		const h = fixture();
		h.end();
		h.internals.notifyParent(h.run, "completed");
		expect(h.internals.pendingRunNotices.size).toBeGreaterThanOrEqual(0);
		h.manager.clearRuns();
		expect(h.internals.pendingRunNotices.size).toBe(0);
	});
});
