/**
 * Merge-safety reporting in the run summary. Write runs hand the leader branches
 * to merge, and the summary is the ONLY place the relationship between those
 * branches is stated — getting it wrong loses work silently.
 */
import { describe, expect, test } from "bun:test";
import { makeSummary } from "../src/format.ts";
import type { RunSnapshot, TaskSnapshot, UsageStats } from "../src/types.ts";

const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };

function task(over: Partial<TaskSnapshot>): TaskSnapshot {
	return {
		id: "task_1",
		runId: "run_x",
		agent: "a",
		task: "do it",
		cwd: "/tmp",
		status: "completed",
		toolCalls: 0,
		finalText: "done",
		usage,
		...over,
	};
}

function run(tasks: TaskSnapshot[]): RunSnapshot {
	return {
		id: "run_x",
		mode: "parallel",
		status: "completed",
		allowIntercom: false,
		notifyPerTask: true,
		createdAt: Date.now(),
		concurrency: 3,
		tasks,
		aggregateUsage: usage,
	};
}

describe("makeSummary merge safety", () => {
	test("sibling branches touching the same file raise a conflict warning", () => {
		const out = makeSummary(
			run([
				task({ id: "task_1", branch: "subagents/run_x/task_1", changedFiles: ["src/auth.ts", "src/a.ts"] }),
				task({ id: "task_2", branch: "subagents/run_x/task_2", changedFiles: ["src/auth.ts"] }),
			]),
		);
		expect(out).toContain("CONFLICT RISK");
		expect(out).toContain("src/auth.ts");
		// The non-overlapping file must not be reported as a conflict.
		expect(out).not.toContain("task_2:src/a.ts");
	});

	test("siblings touching different files raise nothing", () => {
		const out = makeSummary(
			run([
				task({ id: "task_1", branch: "subagents/run_x/task_1", changedFiles: ["src/a.ts"] }),
				task({ id: "task_2", branch: "subagents/run_x/task_2", changedFiles: ["src/b.ts"] }),
			]),
		);
		expect(out).not.toContain("CONFLICT RISK");
	});

	test("a stacked branch says merge the upstream FIRST and is not a conflict", () => {
		const out = makeSummary(
			run([
				task({ id: "task_a", branch: "subagents/run_x/task_a", changedFiles: ["src/auth.ts"] }),
				task({
					id: "task_b",
					branch: "subagents/run_x/task_b",
					stackedOn: "subagents/run_x/task_a",
					changedFiles: ["src/auth.ts"],
				}),
			]),
		);
		expect(out).toContain("Stacked on subagents/run_x/task_a — merge that branch FIRST.");
		// Stacked branches already contain the upstream, so the shared file is expected.
		expect(out).not.toContain("CONFLICT RISK");
	});

	test("in-place isolation is always surfaced with its reason", () => {
		const out = makeSummary(run([task({ isolation: "in-place", isolationReason: "not a git repository" })]));
		expect(out).toContain("Applied IN PLACE (no branch)");
		expect(out).toContain("not a git repository");
	});
});
