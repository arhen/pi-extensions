import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "../src/manager.ts";
import type { RunSnapshot, TaskSnapshot, UsageStats } from "../src/types.ts";

const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
type Kind = "completed" | "failed" | "aborted";

/** failures and ask_parent questions interrupt the leader mid-turn; completions and aborts queue */
describe("failure and ask notices steer, everything else queues", () => {
	function capture(task: Partial<TaskSnapshot>, kind: Kind) {
		const sent: { body: string; deliverAs?: string }[] = [];
		const pi = {
			events: { emit() {} },
			sendUserMessage(body: string, opts?: { deliverAs?: string }) {
				sent.push({ body, deliverAs: opts?.deliverAs });
			},
		} as unknown as ExtensionAPI;

		const base: TaskSnapshot = {
			id: "task_1",
			runId: "run_x",
			agent: "a",
			task: "do it",
			cwd: "/tmp",
			status: kind,
			toolCalls: 0,
			usage,
			...task,
		};
		const run = { id: "run_x", mode: "parallel", status: kind, tasks: [base] } as unknown as RunSnapshot;
		const manager = new SubagentManager(pi) as unknown as {
			notifyTask: (run: RunSnapshot, task: TaskSnapshot, kind: Kind) => void;
		};
		manager.notifyTask(run, base, kind);
		return sent[0];
	}

	test("a task that died mid-work steers, so the leader stops instead of using a broken result", () => {
		const notice = capture({ finalText: "half done", error: "429 rate limited" }, "failed");
		expect(notice?.deliverAs).toBe("steer");
		expect(notice?.body).toContain("resume_subagent");
	});

	test("a never-started task steers too (config error repeats on every respawn)", () => {
		expect(capture({ finalText: "", error: "Model not found: nope/x" }, "failed")?.deliverAs).toBe("steer");
	});

	test("completed and aborted stay queued as follow-ups", () => {
		expect(capture({ finalText: "done" }, "completed")?.deliverAs).toBe("followUp");
		expect(capture({ error: "cancelled" }, "aborted")?.deliverAs).toBe("followUp");
	});

	function captureAsk(extra: { taskId?: string; agent?: string; question?: string; urgent?: boolean }) {
		const sent: { body: string; deliverAs?: string }[] = [];
		const pi = {
			events: { emit() {} },
			sendUserMessage(body: string, opts?: { deliverAs?: string }) {
				sent.push({ body, deliverAs: opts?.deliverAs });
			},
		} as unknown as ExtensionAPI;
		const run = { id: "run_x", mode: "parallel", status: "running", tasks: [] } as unknown as RunSnapshot;
		const manager = new SubagentManager(pi) as unknown as {
			notifyParent: (
				run: RunSnapshot,
				kind: "asked",
				extra: { taskId?: string; agent?: string; question?: string; urgent?: boolean },
			) => void;
		};
		manager.notifyParent(run, "asked", extra);
		return sent[0];
	}

	test("ask_parent steers, labelled not urgent until the child says otherwise", () => {
		const ask = captureAsk({ taskId: "task_2", agent: "probe", question: "which branch?" });
		expect(ask?.deliverAs).toBe("steer");
		expect(ask?.body).toContain("[not urgent]");
		expect(ask?.body).toContain("probe (task_2)");
		expect(ask?.body).toContain("which branch?");
		expect(ask?.body).toContain('reply_subagent({ runId: "run_x", taskId: "task_2"');
	});

	test("an urgent ask tells the leader to answer before its next step", () => {
		const ask = captureAsk({ taskId: "task_2", agent: "probe", question: "which branch?", urgent: true });
		expect(ask?.deliverAs).toBe("steer");
		expect(ask?.body).toContain("[URGENT]");
		expect(ask?.body).toContain("Answer now");
	});
});
