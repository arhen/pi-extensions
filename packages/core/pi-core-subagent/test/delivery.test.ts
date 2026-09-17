import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "../src/manager.ts";
import type { RunSnapshot, TaskSnapshot, UsageStats } from "../src/types.ts";

const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
type Kind = "completed" | "failed" | "aborted";

/**
 * Every child->leader lifecycle notice steers. A `followUp` notice only surfaces once the leader
 * stops calling tools, so a leader that keeps working — or never rests — sees completions too late
 * to act on them while the queue accumulates.
 */
describe("all lifecycle notices steer", () => {
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

	test("completed and aborted steer as well, so the leader sees them mid-turn", () => {
		expect(capture({ finalText: "done" }, "completed")?.deliverAs).toBe("steer");
		expect(capture({ error: "cancelled" }, "aborted")?.deliverAs).toBe("steer");
	});
});
