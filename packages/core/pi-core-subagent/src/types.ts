export type RunMode = "single" | "parallel" | "chain";
export type TaskStatus = "queued" | "starting" | "running" | "awaiting_parent" | "completed" | "failed" | "aborted";
export type RunStatus = "queued" | "running" | "awaiting_parent" | "completed" | "failed" | "aborted";

export const TERMINAL: TaskStatus[] = ["completed", "failed", "aborted"];

export const MAX_TASKS = 16;
/** Run-wide parallelism limits: shared by the scheduler, its schema description, and the catalog readers. */
export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 8;

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
	needs?: string[];
	sessionId?: string;
	sessionFile?: string;
	startedAt?: number;
	endedAt?: number;
	toolCalls: number;
	lastActivity?: string;
	finalText?: string;
	notifiedParent?: boolean;
	error?: string;
	model?: string;
	provider?: string;
	toolsNote?: string;
	thinking?: string;
	tools?: string[];
	usage: UsageStats;
	roster?: string;
	agentFile?: string;
	branch?: string;
	diffStat?: string;
	changedFiles?: string[];
	isolation?: "worktree" | "in-place";
	isolationReason?: string;
	stackedOn?: string;
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
	awaited?: boolean;
}

export interface RunDetails {
	run: RunSnapshot;
}

export interface PendingReply {
	resolve: (message: string) => void;
}

/** One selectable model, as the agent needs it to choose: what to pass, and what it supports. */
export interface SelectableModel {
	/** The value to pass as `model` ("provider/id"). */
	reference: string;
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	/** Levels the runtime honors, always including "off". Never empty for a resolved model. */
	thinkingLevels: string[];
	/** 0 when the provider did not report one. */
	contextWindow: number;
}

export interface ModelCatalog {
	models: SelectableModel[];
	/** References that are NOT safe to pass because another model's bare id would win resolution. */
	ambiguous?: string[];
	/** Why the ambiguous references are unsafe, in full, so the agent can act instead of retrying blindly. */
	reason?: string;
	/** Entries the registry itself could not resolve — a registry fault, distinct from a name collision. */
	unresolved?: string[];
	/** Why those entries failed, so a registry fault is never mistaken for a collision. */
	unresolvedReason?: string;
	/** Set when the catalog could not be read, so the agent knows it is not looking at an empty catalog. */
	unavailable?: string;
}
