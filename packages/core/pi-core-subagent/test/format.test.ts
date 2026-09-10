import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeSummary, SubagentsWidget } from "../src/format.ts";
import type { RunSnapshot, TaskSnapshot, UsageStats } from "../src/types.ts";

const plain = { fg: (_c: string, s: string) => s } as unknown as Theme;

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

	test("a stacked branch reports that it contains its upstream, and is not a conflict", () => {
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

		expect(out).toContain("Stacked on subagents/run_x/task_a");
		expect(out).toContain("merging this one brings both");

		expect(out).not.toContain("CONFLICT RISK");
	});

	test("in-place isolation is always surfaced with its reason", () => {
		const out = makeSummary(run([task({ isolation: "in-place", isolationReason: "not a git repository" })]));
		expect(out).toContain("Applied IN PLACE (no branch)");
		expect(out).toContain("not a git repository");
	});
});

describe("SubagentsWidget", () => {
	test("live tasks survive the 4-row budget, finished ones go behind +n more", () => {
		const finished = Array.from({ length: 12 }, (_, i) =>
			task({ id: `done_${i}`, agent: `done-${i}`, status: "completed" }),
		);
		const live = [
			task({ id: "live_1", agent: "running-1", status: "running" }),
			task({ id: "live_2", agent: "running-2", status: "running" }),
		];

		const out = new SubagentsWidget(() => [run([...finished, ...live])], plain).render(200).join("\n");

		expect(out).toContain("Subagents (12/14)");
		expect(out).toContain("running-1");
		expect(out).toContain("running-2");
		expect(out).toContain("+10 more");
		expect(out).not.toContain("done-2");
		// header + 4 rows + the "+n more" footer
		expect(out.split("\n")).toHaveLength(6);
	});
});
