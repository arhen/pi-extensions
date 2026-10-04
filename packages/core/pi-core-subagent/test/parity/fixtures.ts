import type { RunSnapshot, TaskSnapshot, UsageStats } from "../../src/types.ts";

export function usage(over: Partial<UsageStats> = {}): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
		...over,
	};
}

export function task(over: Partial<TaskSnapshot> & { id: string }): TaskSnapshot {
	return {
		runId: "run_parity",
		agent: "agent",
		task: "goal",
		cwd: "/tmp",
		status: "completed",
		toolCalls: 0,
		usage: usage(),
		...over,
	};
}

export function run(over: Partial<RunSnapshot> & { id: string; tasks: TaskSnapshot[] }): RunSnapshot {
	return {
		mode: "parallel",
		status: "completed",
		notifyPerTask: true,
		createdAt: 1000,
		concurrency: 3,
		aggregateUsage: usage(),
		...over,
	};
}
