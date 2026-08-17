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
	thinking?: string;
	tools?: string[];
	usage: UsageStats;
	/** Sibling addresses for intercom tools (send_agent_message targets). */
	roster?: string;
}

export interface RunSnapshot {
	id: string;
	mode: RunMode;
	status: RunStatus;
	background: boolean;
	allowIntercom: boolean;
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
	background?: boolean;
}

export interface PendingReply {
	resolve: (message: string) => void;
}
