/** Shared run/task types for the subagent extension. No imports. */

export type RunMode = "single" | "parallel" | "chain";
export type TaskStatus = "queued" | "starting" | "running" | "awaiting_parent" | "completed" | "failed" | "aborted";
export type RunStatus = "queued" | "running" | "awaiting_parent" | "completed" | "failed" | "aborted";

export const TERMINAL: TaskStatus[] = ["completed", "failed", "aborted"];

/** Widget/command cap on rendered tasks; scheduler cap on spawned tasks. */
export const MAX_TASKS = 16;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface TaskSnapshot {
	id: string;
	runId: string;
	agent: string;
	task: string;
	cwd: string;
	status: TaskStatus;
	/** Resolved dependency edges (task ids). Empty/absent = wave 1. */
	needs?: string[];
	sessionId?: string;
	sessionFile?: string;
	startedAt?: number;
	endedAt?: number;
	toolCalls: number;
	lastActivity?: string;
	finalText?: string;
	error?: string;
	model?: string;
	/** Why `model` is not what was requested: preflight failed and the session's
	 *  model took over. Silent substitution is worse than a slow spawn. */
	modelNote?: string;
	thinking?: string;
	tools?: string[];
	usage: UsageStats;
	/** Sibling addresses for intercom tools (send_agent_message targets). */
	roster?: string;
	/** Path of the agent file that drove this child (inline definition otherwise).
	 *  Surfaced so the leader can audit which file took over — a description-only
	 *  match must never be invisible. */
	agentFile?: string;
	/** Git worktree isolation (write agents): branch + diff of the child's changes. */
	branch?: string;
	diffStat?: string;
	changedFiles?: string[];
	/** How a write child's edits were applied. "in-place" means NO branch: the
	 *  changes are already in the leader's tree — always surfaced, never silent. */
	isolation?: "worktree" | "in-place";
	isolationReason?: string;
	/** Upstream branch this one was built on top of. Merge that one FIRST — these
	 *  are stacked, not independent. Absent = branched from the base tree. */
	stackedOn?: string;
	/** Worktree commit/diff trouble. Kept apart from `error` so a completed task
	 *  still reports its answer. */
	worktreeError?: string;
}

export interface RunSnapshot {
	id: string;
	mode: RunMode;
	status: RunStatus;
	notifyPerTask: boolean;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	concurrency: number;
	tasks: TaskSnapshot[];
	aggregateUsage: UsageStats;
	/** True once the parent awaited this run — completion notices are redundant then. */
	awaited?: boolean;
}

export interface RunDetails {
	run: RunSnapshot;
}

export interface PendingReply {
	resolve: (message: string) => void;
}
