/** SubagentManager: run lifecycle, child sessions, intercom, persistence, widget plumbing. */
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { resolveAgentFile } from "./agentfile.ts";
import { CHILD_TALK_TOOLS, type ChildHandlers, createChildTools, createWatchdog, type Watchdog } from "./child.ts";
import {
	activitySnippet,
	describeCall,
	getFirstText,
	isTalking,
	makeNotice,
	makeTaskNotice,
	SubagentsWidget,
	truncateText,
} from "./format.ts";
import { applyUpstream, resolveNeeds, runWaveScheduler } from "./graph.ts";
import { createMailbox, type Mailbox } from "./mailbox.ts";
import type { SubagentParamsShape, TaskInput } from "./schemas.ts";
import {
	MAX_TASKS,
	type PendingReply,
	type RunDetails,
	type RunMode,
	type RunSnapshot,
	type RunStatus,
	type TaskSnapshot,
	type TaskStatus,
	TERMINAL,
	type UsageStats,
} from "./types.ts";
import {
	branchDiff,
	claimWorktree,
	cleanupMerged,
	commitWorktree,
	createWorktree,
	removeWorktree,
	repoRoot,
	type Worktree,
} from "./worktree.ts";

export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 8;
/** No default wall-clock cap: a subagent runs until its task is done, it stalls, or the user aborts. */
const DEFAULT_RUNTIME_MS = 0;
const DEFAULT_STALL_MS = 180_000; // 3 min: long model thinking streams emit no events, but they're not stalled.
/** Cap on a child's wait for reply_subagent — an ignored question must not pin the run open forever. */
const PARENT_REPLY_TIMEOUT_MS = 600_000; // 10 min
/** Intercom messages buffered per park before the followUp path takes over. */
const PARKED_MSG_CAP = 24;
const READONLY_TOOLS = ["read", "grep", "find", "ls"];
const WRITE_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
/** Tools that can mutate the tree — their presence is what earns a worktree. */
const WRITE_CAPABLE = ["bash", "edit", "write"];
/** Task ids become git refs + filesystem paths. */
const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WIDGET_THROTTLE_MS = 150;

// ── helpers ──────────────────────────────────────────────────────────────

function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}
function aggregateUsage(tasks: TaskSnapshot[]): UsageStats {
	const total = emptyUsage();
	for (const task of tasks) {
		total.input += task.usage.input;
		total.output += task.usage.output;
		total.cacheRead += task.usage.cacheRead;
		total.cacheWrite += task.usage.cacheWrite;
		total.cost += task.usage.cost;
		total.turns += task.usage.turns;
	}
	return total;
}
/** realpath when possible; the raw path otherwise (cwd may not exist yet). */
function safeRealPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
function getParentSessionFile(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile?.();
	} catch {
		return undefined;
	}
}
/**
 * pi 0.84 StopReason enum: "stop" is NORMAL completion (was "end" in older pi).
 * Only length/error/aborted/deferred/pending/toolUse-as-final are failures.
 */
export function classifyFailure(
	stopReason: string | undefined,
	errorMessage?: string,
): { status: "failed" | "aborted"; message: string } | undefined {
	if (!stopReason || stopReason === "stop" || stopReason === "end") return undefined;
	if (stopReason === "aborted") return { status: "aborted", message: errorMessage || "Subagent was aborted." };
	return { status: "failed", message: errorMessage || `Subagent ended with stopReason "${stopReason}".` };
}
function lastAssistantFailure(
	messages: AssistantMessage[] | undefined,
): { status: "failed" | "aborted"; message: string } | undefined {
	for (const message of [...(messages ?? [])].reverse()) {
		if (message?.role !== "assistant") continue;
		return classifyFailure(message.stopReason, message.errorMessage);
	}
	return undefined;
}
function failureError(failure: { status: "failed" | "aborted"; message: string }): Error {
	const error = new Error(failure.message);
	(error as Error & { subagentStatus?: string }).subagentStatus = failure.status;
	return error;
}
function updateUsageFromMessage(task: TaskSnapshot, message: AssistantMessage): void {
	if (message?.role !== "assistant") return;
	task.usage.turns += 1;
	const usage = message.usage;
	if (!usage) return;
	task.usage.input += usage.input ?? 0;
	task.usage.output += usage.output ?? 0;
	task.usage.cacheRead += usage.cacheRead ?? 0;
	task.usage.cacheWrite += usage.cacheWrite ?? 0;
	task.usage.cost += usage.cost?.total ?? 0;
	if (message.model && !task.model) task.model = message.model;
}
export function cloneRun(run: RunSnapshot): RunSnapshot {
	return JSON.parse(JSON.stringify(run)) as RunSnapshot;
}
/** Resolve a child model from the pi model registry.
 *  Order: explicit "provider/model-id" or bare id (searched across available
 *  models) → agent file model → parent's current model (ctx.model) → undefined
 *  (createAgentSession falls back to settings). */
export function resolveChildModel(ctx: ExtensionContext, explicit: string | undefined) {
	if (!explicit?.trim()) return ctx.model; // inherit the parent's active model
	const ref = explicit.trim();
	const available = ctx.modelRegistry.getAvailable();
	// Model ids can contain slashes (e.g. 9router/cc/claude-opus-5), so a bare id
	// match and every provider/id split point must be tried, not just the first.
	const byId = available.find((m) => m.id === ref);
	if (byId) return byId;
	for (let slash = ref.indexOf("/"); slash > 0; slash = ref.indexOf("/", slash + 1)) {
		const model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
		if (model) return model;
	}
	throw new Error(`Model not found: ${ref}`);
}

/** Extension-registered providers (e.g. 9router) live only in the parent's
 *  in-memory runtime. A child builds its runtime from disk and would lose them,
 *  so replay the parent's registrations before the child resolves auth. */
async function createChildModelRuntime(ctx: ExtensionContext) {
	const ids = ctx.modelRegistry.getRegisteredProviderIds?.() ?? [];
	if (ids.length === 0) return undefined; // no extension providers: disk runtime is enough
	const agentDir = getAgentDir();
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	for (const id of ids) {
		const native = ctx.modelRegistry.getRegisteredNativeProvider?.(id);
		if (native) {
			runtime.registerNativeProvider(native);
			continue;
		}
		const config = ctx.modelRegistry.getRegisteredProviderConfig?.(id);
		if (config) runtime.registerProvider(id, config);
	}
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

/** Validate a thinking level against the RESOLVED model's registry entry.
 *  thinkingLevelMap: null = unsupported, missing key = provider default,
 *  absent map = provider defaults. Non-reasoning models only accept "off". */
export function validateThinking(model: Model<Api> | undefined, level: string | undefined): void {
	if (!level || level === "off") return;
	if (!model) return;
	const map = model.thinkingLevelMap;
	if (map && level in map && map[level as keyof typeof map] === null) {
		const supported = Object.keys(map).filter((k) => map[k as keyof typeof map] !== null);
		throw new Error(
			`Thinking level "${level}" is not supported by ${model.provider}/${model.id}. Supported: ${supported.length ? supported.join(" | ") : 'none — use thinking: "off"'}.`,
		);
	}
	if (!model.reasoning) {
		throw new Error(`Model ${model.provider}/${model.id} does not support thinking. Use thinking: "off".`);
	}
}

// Cached catalog removed: agents are defined inline by the leader per call,
// so there is nothing to inject into the parent context. Zero per-request cost.

interface ChildEventState {
	pendingFailure?: ReturnType<typeof classifyFailure>;
	failChildEnd?: (error: Error) => void;
	childEndResolve?: () => void;
}

export interface ParkedMsg {
	kind: "ask" | "notify" | "done";
	taskId: string;
	agent: string;
	text: string;
}

export class SubagentManager {
	private runs = new Map<string, RunSnapshot>();
	/** Runs that are still settleable (presence = not yet settled). */
	private settlers = new Map<string, true>();
	/** Everyone parked on a run — a set, so re-parking can't build a closure chain. */
	private settleWaiters = new Map<string, Set<(run: RunSnapshot) => void>>();
	private pendingReplies = new Map<string, PendingReply>();
	private liveChildren = new Map<
		string,
		{ abort: () => void; dispose: () => void; touchWatchdog: () => void; steer: (message: string) => void }
	>();
	private mailboxes: Mailbox = createMailbox();
	/** Live worktrees by `${runId}:${taskId}` — lets cancel drop dirs and keeps
	 *  cleanup from touching a branch that a running child owns. */
	private liveWorktrees = new Map<string, Worktree>();
	private runControllers = new Map<string, AbortController>();
	private widgetTimers = new Map<string, ReturnType<typeof setTimeout>>(); // per-run stream throttle
	private widgetRuns: RunSnapshot[] = [];
	private eventSeq = 0;

	/** When false, strip leader-imposed maxRuntimeMs so tasks run unlimited — toggle via `/subagents auto-limit on|off`. */
	private autoLimit = true;

	turnActivity = false;

	constructor(private readonly pi: ExtensionAPI) {
		try {
			const cfg = JSON.parse(readFileSync(join(getAgentDir(), "subagents-config.json"), "utf8"));
			if (typeof cfg.autoLimit === "boolean") this.autoLimit = cfg.autoLimit;
		} catch {
			/* no config yet — defaults */
		}
	}

	/** Flip the auto-limit flag; persists to the agent dir. Returns the new value. */
	setAutoLimit(on: boolean): boolean {
		this.autoLimit = on;
		void writeFile(join(getAgentDir(), "subagents-config.json"), JSON.stringify({ autoLimit: on }, null, 2)).catch(
			() => {},
		);
		return on;
	}

	get autoLimitOn(): boolean {
		return this.autoLimit;
	}

	/** Any run still has queued/running tasks? */
	hasActiveRun(): boolean {
		for (const run of this.runs.values()) {
			if (run.tasks.some((t) => !TERMINAL.includes(t.status))) return true;
		}
		return false;
	}

	/** Hide the widget + clear the footer status entry. */
	clearWidget(ctx: ExtensionContext): void {
		this.widgetRuns = [];
		this.widgetTui = null;
		if (ctx.hasUI) {
			try {
				ctx.ui.setWidget("subagents", undefined);
			} catch {
				/* ignore */
			}
		}
	}

	listRuns(): RunSnapshot[] {
		return Array.from(this.runs.values()).sort((a, b) => b.createdAt - a.createdAt);
	}
	getRun(runId: string | undefined): RunSnapshot | undefined {
		return runId ? this.runs.get(runId) : undefined;
	}
	clearRuns(): void {
		for (const child of this.liveChildren.values()) {
			child.abort();
			child.dispose();
		}
		this.liveChildren.clear();
		// Mark every non-terminal task aborted BEFORE resolving pendingReplies: the
		// resumed onAskParent closure re-checks status, and a still-awaiting task
		// would flip back to "running" and re-insert the run after the maps clear —
		// a ghost run that widgets re-arm on and persist forever.
		for (const run of this.runs.values()) {
			for (const task of run.tasks) {
				if (!TERMINAL.includes(task.status)) {
					task.status = "aborted";
					task.error = task.error ?? "(session ended)";
				}
			}
		}
		// Release anyone parked on a run before the maps go — dropping waiters would
		// leave their promises pending forever (autoAwait / await_subagent hang).
		for (const [runId, waiters] of this.settleWaiters) {
			const run = this.runs.get(runId);
			for (const waiter of waiters) waiter(run ? cloneRun(run) : ({ id: runId, status: "aborted" } as RunSnapshot));
		}
		for (const pending of this.pendingReplies.values()) {
			pending.resolve("(session ended — stop work immediately)");
		}
		this.parked.clear();
		// Ownership markers stay on disk; the next session reaps those dirs (commit,
		// keep branch, drop dir) once this pid is gone.
		this.liveWorktrees.clear();
		this.runs.clear();
		this.settlers.clear();
		this.settleWaiters.clear();
		this.pendingReplies.clear();
		this.runControllers.clear();
		this.mailboxes = createMailbox();
		this.widgetTui = null; // force re-registration on the next session
		if (this.pulseTimer) {
			clearTimeout(this.pulseTimer);
			this.pulseTimer = null;
		}
		for (const t of this.widgetTimers.values()) clearTimeout(t);
		this.widgetTimers.clear();
		this.widgetRuns = [];
	}

	// ── persistence (sidecar per parent session) ────────────────────────
	async restoreFromSidecar(ctx: ExtensionContext): Promise<void> {
		const parentFile = getParentSessionFile(ctx);
		if (!parentFile) return;
		const sidecar = parentFile.replace(/\.jsonl$/, ".subagents.json");
		let runs: RunSnapshot[];
		try {
			if (!existsSync(sidecar)) return;
			const raw = JSON.parse(readFileSync(sidecar, "utf-8"));
			if (!Array.isArray(raw)) return;
			runs = (raw as RunSnapshot[]).map((run) => {
				const interrupted = run.tasks.some((t) => !TERMINAL.includes(t.status));
				// A persisted "running" run whose tasks are all terminal (crash between
				// task end and run end) must not stay "running" forever.
				let status = interrupted ? ("aborted" as RunStatus) : run.status;
				if (!TERMINAL.includes(status)) {
					const anyFailed = run.tasks.some((t) => t.status === "failed");
					const anyAborted = run.tasks.some((t) => t.status === "aborted");
					status = anyFailed ? "failed" : anyAborted ? "aborted" : "completed";
				}
				return {
					...run,
					status,
					endedAt: interrupted ? Date.now() : run.endedAt,
					tasks: run.tasks.map((t) =>
						TERMINAL.includes(t.status)
							? t
							: { ...t, status: "aborted" as TaskStatus, error: t.error || "Interrupted by session reload" },
					),
				};
			});
		} catch {
			return;
		}
		let added = 0;
		for (const run of runs) {
			if (!run?.id || this.runs.has(run.id)) continue;
			this.runs.set(run.id, run);
			added += 1;
		}
		if (added > 0) {
			this.emit("subagent:runs-restored", { count: added });
			this.scheduleWidget(this.listRuns()[0], ctx);
		}
	}
	private persist(ctx: ExtensionContext): void {
		try {
			const parentFile = getParentSessionFile(ctx);
			if (!parentFile) return;
			const sidecar = parentFile.replace(/\.jsonl$/, ".subagents.json");
			// Write-then-rename: a plain writeFile can tear on crash and silently drop
			// ALL run history for the session on the next read.
			const tmp = `${sidecar}.tmp`;
			const payload = JSON.stringify(this.listRuns().slice(0, 50).map(cloneRun), null, 2);
			void writeFile(tmp, payload)
				.then(() => rename(tmp, sidecar))
				.catch(() => {}); // never surface as an unhandled rejection
		} catch {
			/* ignore */
		}
	}

	private emit(type: string, payload: Record<string, unknown>): void {
		this.pi.events.emit(type, { type, timestamp: Date.now(), ...payload });
	}

	/** Per-task wake-up: queued follow-up so the parent can interleave responses. */
	private notifyTask(run: RunSnapshot, task: TaskSnapshot, kind: "completed" | "failed" | "aborted"): void {
		const body = makeTaskNotice(run, task, kind);
		// Parked leader (await_subagent) receives completions through the wait — no queue.
		if (this.collectParked(run.id, { kind: "done", taskId: task.id, agent: task.agent, text: body })) {
			this.emit("subagent:notification", { runId: run.id, taskId: task.id, kind, body });
			return;
		}
		try {
			this.pi.sendUserMessage(body, { deliverAs: "followUp" });
		} catch {
			/* parent mid-stream; consumers can poll subagent_status */
		}
		this.emit("subagent:notification", { runId: run.id, taskId: task.id, kind, body });
	}

	/** Wake the parent with a 3-line notice. Full text stays out of context.
	 *  deliverAs followUp queues the message if the parent is mid-stream
	 *  (e.g. inside await_subagent) instead of throwing/aborting. */
	private notifyParent(
		run: RunSnapshot,
		kind: "completed" | "failed" | "aborted" | "asked",
		extra?: { taskId?: string; question?: string },
	): void {
		if (kind !== "asked" && run.awaited) return; // parent already got the result via await_subagent
		const body =
			kind === "asked"
				? `A subagent is asking you a question (task ${extra?.taskId}): ${extra?.question ?? ""}\nReply with reply_subagent(runId: "${run.id}", taskId: "${extra?.taskId}", message: ...).`
				: makeNotice(run, kind);
		try {
			this.pi.sendUserMessage(body, { deliverAs: "followUp" });
		} catch {
			/* parent mid-stream; consumers can poll subagent_status */
		}
		this.emit("subagent:notification", { runId: run.id, kind, body });
	}

	// Widget: register-once + requestRender (todo-overlay pattern).
	// scheduleWidget throttles status changes into requestRender calls.
	private widgetTui: TUI | null = null;
	/** Upsert a run into the widget's visible set (all runs, not just the latest). */
	private upsertWidgetRun(run: RunSnapshot | undefined): void {
		if (!run) return;
		const idx = this.widgetRuns.findIndex((r) => r.id === run.id);
		if (idx >= 0) this.widgetRuns[idx] = run;
		else this.widgetRuns.push(run);
	}
	private scheduleWidget(run: RunSnapshot | undefined, ctx?: ExtensionContext): void {
		this.upsertWidgetRun(run);
		if (!run || this.widgetTimers.has(run.id)) return;
		this.widgetTimers.set(
			run.id,
			setTimeout(() => {
				this.widgetTimers.delete(run.id);
				if (ctx?.hasUI) {
					this.ensureWidget(ctx);
					this.widgetTui?.requestRender();
				}
				this.maybePulse(ctx);
			}, WIDGET_THROTTLE_MS),
		);
	}

	/** While any live task's last activity is a talk tool, keep re-rendering so its name pulses. */
	private pulseTimer: ReturnType<typeof setTimeout> | null = null;
	private maybePulse(ctx?: ExtensionContext): void {
		if (this.pulseTimer || !this.widgetTui) return;
		const talking = this.widgetRuns.some((r) => r.tasks.some(isTalking));
		if (!talking) return; // last tick stops the loop: talking→normal resumes instantly
		this.pulseTimer = setTimeout(() => {
			this.pulseTimer = null;
			this.widgetTui?.requestRender();
			this.maybePulse(ctx);
		}, 700);
	}
	private flushWidget(run: RunSnapshot | undefined, ctx?: ExtensionContext, onUpdate?: (partial: any) => void): void {
		if (run) {
			const t = this.widgetTimers.get(run.id);
			if (t) {
				clearTimeout(t);
				this.widgetTimers.delete(run.id);
			}
		}
		if (!run || this.widgetRuns.length === 0) return;
		if (ctx?.hasUI) {
			this.ensureWidget(ctx);
			this.widgetTui?.requestRender();
		}
		this.maybePulse(ctx);
		// Transcript gets one status line only — the live per-task view is the widget's job.
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `${run.tasks.filter((t) => TERMINAL.includes(t.status)).length}/${run.tasks.length} done · ${run.status}`,
				},
			],
		});
	}
	private ensureWidget(ctx: ExtensionContext): void {
		if (this.widgetTui !== null || !ctx.hasUI) return;
		ctx.ui.setWidget(
			"subagents",
			(tui, theme) => {
				this.widgetTui = tui;
				return new SubagentsWidget(() => [...this.widgetRuns], theme);
			},
			{ placement: "aboveEditor" },
		);
	}

	private updateRun(run: RunSnapshot, ctx?: ExtensionContext, _onUpdate?: (partial: any) => void): void {
		run.aggregateUsage = aggregateUsage(run.tasks);
		this.runs.set(run.id, run);
		this.emit("subagent:run-updated", {
			runId: run.id,
			status: run.status,
			live: run.tasks.filter((t) => !TERMINAL.includes(t.status)).length,
		});
		this.scheduleWidget(run, ctx);
	}
	private updateTask(
		run: RunSnapshot,
		task: TaskSnapshot,
		patch: Partial<TaskSnapshot>,
		ctx: ExtensionContext,
		onUpdate?: (partial: any) => void,
	): void {
		Object.assign(task, patch);
		this.emit("subagent:task-updated", { runId: run.id, taskId: task.id, status: task.status });
		this.updateRun(run, ctx, onUpdate);
	}

	// ── intercom + mailbox ──────────────────────────────────────────────
	private makeChildHandlers(run: RunSnapshot, task: TaskSnapshot, ctx: ExtensionContext): ChildHandlers {
		return {
			onAskParent: async (_taskId, question) => {
				const key = `${run.id}:${task.id}`;
				// A tool call already in flight can reach here AFTER the task ended
				// (abort/timeout/cancel). Reviving it would leave a "running" task in a
				// finished run — hasActiveRun() then never clears.
				if (TERMINAL.includes(task.status)) {
					return "(your task has already ended — stop work and return immediately)";
				}
				this.updateTask(run, task, { status: "awaiting_parent" }, ctx);
				this.liveChildren.get(key)?.touchWatchdog();
				// While the leader is parked in await_subagent the question rides the wait
				// (no steering queue, no turn boundary); otherwise it goes out as a notice.
				// Either way the pending reply entry must exist, or reply_subagent has
				// nowhere to land and the child waits on an answer that never comes.
				if (!this.collectParked(run.id, { kind: "ask", taskId: task.id, agent: task.agent, text: question })) {
					this.notifyParent(run, "asked", { taskId: task.id, question });
				}
				// A waiting child is not stalled — keep the watchdog fed until the reply.
				// But the wait is BOUNDED: an unanswered question would otherwise keep the
				// run non-terminal forever (widget never clears, run never settles).
				const keepAlive = setInterval(() => this.liveChildren.get(key)?.touchWatchdog(), 30_000);
				try {
					const reply = await this.awaitParentReply(run.id, task.id, PARENT_REPLY_TIMEOUT_MS);
					// Cancel wins over a reply that arrived in the same tick: never move a
					// terminal task back to "running" (that would let a canceled task be
					// reported as completed).
					if (TERMINAL.includes(task.status)) {
						return "(your task was canceled while you waited — stop work and return immediately)";
					}
					this.updateTask(run, task, { status: "running" }, ctx);
					this.liveChildren.get(key)?.touchWatchdog();
					return reply;
				} finally {
					clearInterval(keepAlive);
				}
			},
			onNotifyParent: (_taskId, message, level) => {
				this.emit("subagent:intercom", { runId: run.id, taskId: task.id, kind: "notify", level, message });
				// Parked leader gets it through the wait; otherwise queue it. `awaited` must
				// NOT gate this — between two parks the leader is awaited but listening.
				if (this.collectParked(run.id, { kind: "notify", taskId: task.id, agent: task.agent, text: message })) return;
				try {
					this.pi.sendUserMessage(`[Subagent ${task.agent}] ${message}`, { deliverAs: "followUp" });
				} catch {
					/* parent mid-stream */
				}
			},
			onSendMessage: (_taskId, to, text) => {
				if (to === "leader") {
					this.emit("subagent:intercom", {
						runId: run.id,
						taskId: task.id,
						kind: "notify",
						level: "info",
						message: text,
					});
					if (this.collectParked(run.id, { kind: "notify", taskId: task.id, agent: task.agent, text })) return true;
					try {
						this.pi.sendUserMessage(`[Subagent ${task.agent}] ${text}`, { deliverAs: "followUp" });
					} catch {
						/* parent mid-stream */
					}
					return true;
				}
				// Run-scoped keys: sibling ids are run-local; cross-run task_1 can never collide.
				return this.mailboxes.send(`${run.id}:${task.id}`, `${run.id}:${to}`, text);
			},
			onPollMailbox: (taskId) => this.mailboxes.poll(`${run.id}:${taskId}`),
		};
	}
	private awaitParentReply(runId: string, taskId: string, timeoutMs = 0): Promise<string> {
		const key = `${runId}:${taskId}`;
		return new Promise<string>((resolve) => {
			// Identity-tagged: two asks from one child must not delete each other's
			// entry (the loser would hang until its own timer).
			const entry: PendingReply = {
				resolve: (message) => {
					if (timer) clearTimeout(timer);
					if (this.pendingReplies.get(key) === entry) this.pendingReplies.delete(key);
					resolve(message);
				},
			};
			const timer =
				timeoutMs > 0
					? setTimeout(
							() =>
								entry.resolve(
									"The parent did not answer in time. Proceed autonomously with your best judgment and state the assumption you made in your final answer.",
								),
							timeoutMs,
						)
					: undefined;
			this.pendingReplies.set(key, entry);
		});
	}
	deliverReply(runId: string, taskId: string, message: string): boolean {
		const pending = this.pendingReplies.get(`${runId}:${taskId}`);
		if (!pending) return false;
		pending.resolve(message); // clears its own entry + timer
		return true;
	}

	/**
	 * Child session events → task state. Extracted from runChild so the
	 * per-event classification is readable and unit-testable.
	 */
	private onChildEvent(
		event: AgentSessionEvent,
		run: RunSnapshot,
		task: TaskSnapshot,
		ctx: ExtensionContext,
		onUpdate: ((partial: any) => void) | undefined,
		watchdog: Watchdog,
		state: ChildEventState,
	): void {
		const active =
			event.type === "message_update" ||
			event.type === "message_end" ||
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end" ||
			event.type === "bash_execution_update" ||
			event.type === "agent_settled";
		if (active) {
			watchdog.touch();
			this.emit("subagent:session-event", {
				runId: run.id,
				taskId: task.id,
				seq: this.eventSeq++,
				event: { type: event.type },
			});
		}
		if (event.type === "tool_execution_start") {
			this.updateTask(
				run,
				task,
				{ toolCalls: task.toolCalls + 1, lastActivity: describeCall(event.toolName, event.args, task.cwd) },
				ctx,
				onUpdate,
			);
		} else if (event.type === "tool_execution_end") {
			this.scheduleWidget(run, ctx);
		} else if (event.type === "message_end") {
			const message = event.message as AssistantMessage;
			if (message?.role === "assistant") {
				updateUsageFromMessage(task, message);
				const text = getFirstText(message);
				if (text) {
					task.finalText = truncateText(text);
					task.lastActivity = activitySnippet(text);
				}
				state.pendingFailure = classifyFailure(message.stopReason, message.errorMessage);
			}
			this.updateRun(run, ctx, onUpdate);
		} else if (event.type === "agent_end") {
			if (event.willRetry) {
				state.pendingFailure = undefined; // retry in flight — don't trust stale failures
			} else {
				const failure = lastAssistantFailure(event.messages as AssistantMessage[]);
				if (failure) {
					state.pendingFailure = failure;
					state.failChildEnd?.(failureError(failure));
				}
				// NOTE: success does NOT resolve childEndPromise here — pi may run a
				// continuation leg (compaction/overflow recovery) that emits another
				// agent_end. Resolve only on agent_settled, after all legs finish.
			}
		} else if (event.type === "agent_settled") {
			state.childEndResolve?.();
		}
	}

	private async runChild(
		run: RunSnapshot,
		task: TaskSnapshot,
		input: TaskInput,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onUpdate?: (partial: any) => void,
	): Promise<void> {
		if (TERMINAL.includes(task.status)) return; // canceled while queued

		// Matched user agent file (`.agents/agents` etc., by description): the file
		// is authoritative — body = system prompt, frontmatter model/tools win over
		// inline. No match → inline on-demand definition as usual.
		const file = resolveAgentFile(input.agent, input.task, task.cwd, getAgentDir());
		if (file?.path) task.agentFile = file.path; // recorded for audit — which file won
		const prompt = file?.body ?? input.prompt?.trim();
		const thinking = input.thinking;
		// Trust boundary: a file can NARROW the toolset (intersect with the leader's
		// intent) but never widen it — a repo-planted agent file can't grant write.
		const allowedTools = input.write ? WRITE_TOOLS : READONLY_TOOLS;
		const fileTools = file?.tools?.filter((t) => allowedTools.includes(t));
		const baseTools = fileTools?.length ? fileTools : (input.tools ?? allowedTools);
		const tools = [...baseTools, ...(run.allowIntercom ? CHILD_TALK_TOOLS : [])];
		// Isolation follows the DELIVERED toolset, never the raw request: explicit
		// tools: [bash] without write:true still gets a worktree, and a file that
		// narrowed the child to read-only never gets the commit/merge ceremony.
		const canWrite = baseTools.some((t) => WRITE_CAPABLE.includes(t));

		// Write agents run in an isolated git worktree (branch subagents/<run>/<task>);
		// Model + thinking resolve against the pi model registry BEFORE any worktree
		// exists — a bad request fails the TASK with a helpful message and can't leak a
		// checkout past this early return.
		let model: Model<Api> | undefined;
		try {
			model = resolveChildModel(ctx, file?.model ?? input.model);
			validateThinking(model, thinking);
		} catch (err) {
			this.updateTask(
				run,
				task,
				{
					status: "failed",
					error: err instanceof Error ? err.message : String(err),
					endedAt: Date.now(),
				},
				ctx,
				onUpdate,
			);
			return;
		}

		// Write agents run in an isolated git worktree (branch subagents/<run>/<task>);
		// non-git repos fall back to in-place. Created BEFORE session start so the
		// child's cwd + AGENTS.md context chain are the worktree's.
		let wt: Worktree | undefined;
		let isolationReason: string | undefined;
		if (canWrite) {
			try {
				wt = createWorktree(task.cwd, run.id, task.id);
				if (!wt) isolationReason = "not a git repository";
			} catch (err) {
				wt = undefined; // git failure → in-place
				isolationReason = `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`;
			}
		}
		// Map a per-task cwd subpath into the worktree so relative paths stay correct.
		// Both sides go through realpath — a symlinked root would otherwise look
		// "outside" the repo. If the mapping can't be trusted, drop the worktree AND
		// reset the cwd (never point the child at a dir that was just removed).
		let childCwd = wt?.path ?? task.cwd;
		if (wt) {
			const rel = relative(safeRealPath(wt.root), safeRealPath(task.cwd));
			if (rel === ".." || rel.startsWith(`..${sep}`)) {
				removeWorktree(wt);
				wt = undefined;
				childCwd = task.cwd;
				isolationReason = "task cwd is outside the repository";
			} else if (rel && rel !== ".") {
				childCwd = join(wt.path, rel);
				// The subpath may be gitignored/untracked, so it won't exist in a fresh
				// checkout — create it rather than fail session start.
				try {
					mkdirSync(childCwd, { recursive: true });
				} catch {
					childCwd = wt.path;
				}
			}
		}
		if (canWrite) {
			// Never let isolation lapse quietly: the leader must know its edits landed
			// straight in the working tree with no branch to review.
			task.isolation = wt ? "worktree" : "in-place";
			task.isolationReason = wt ? undefined : (isolationReason ?? "worktree unavailable");
		}
		if (wt) {
			claimWorktree(wt); // pid marker: another pi session must not reap this
			this.liveWorktrees.set(`${run.id}:${task.id}`, wt);
		}

		this.updateTask(
			run,
			task,
			{
				status: "starting",
				startedAt: Date.now(),
				// Upstream outputs were spliced in by the scheduler; the snapshot must show
				// the prompt the child actually receives.
				task: input.task,
				model: input.model,
				thinking,
				tools,
			},
			ctx,
			onUpdate,
		);

		// Set once the dir must outlive this call: committed work awaiting the
		// leader's merge, or a commit failure whose work exists ONLY in the dir.
		let keepWorktreeDir = false;
		let child: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let unsubscribe: (() => void) | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;
		const watchdog = createWatchdog(DEFAULT_STALL_MS, `Subagent ${task.agent}`);
		const childState: ChildEventState = {};

		const key = `${run.id}:${task.id}`;
		try {
			const subagentInstruction = run.allowIntercom
				? `You are running as a subagent. Your bash tool already executes in the project working directory — never prefix commands with \`cd\`. Do not call subagent/delegation tools unless the parent explicitly asks. Return a concise final answer. You MAY use ask_parent only when truly blocked on information only the parent has; notify_parent for one-way updates; send_agent_message/poll_agent_messages to coordinate with siblings. Your mailbox address and siblings: ${task.roster ?? "(none)"}. Use the exact task ids (e.g. task_2) as send_agent_message targets. Siblings run independently and may start late or finish early — never block indefinitely on their replies: poll at most 5 times, then proceed with your best judgment. A gated sibling (marked ↳ waits in the graph) may not be running yet; do not wait for it. Stalled waits get the whole run killed. When your work is done, call notify_parent ONCE with a concise result summary — key findings, verdicts, file:line evidence — so the leader can start consuming your output before the run finishes.${wt ? ` You work in an isolated git worktree (branch ${wt.branch}). Never run git commands that switch branches, create branches, or move the worktree (git switch/checkout/branch/worktree). The extension commits your changes when you finish. git status/diff are fine for inspecting your own changes.` : ""}`
				: `You are running as a subagent. Your bash tool already executes in the project working directory — never prefix commands with \`cd\`. Do not call subagent/delegation tools unless the parent explicitly asks. Return a concise final answer for the parent agent.${wt ? ` You work in an isolated git worktree (branch ${wt.branch}). Never run git commands that switch branches, create branches, or move the worktree (git switch/checkout/branch/worktree). The extension commits your changes when you finish. git status/diff are fine for inspecting your own changes.` : ""}`;

			const loader = new DefaultResourceLoader({
				cwd: childCwd,
				agentDir: getAgentDir(),
				noExtensions: true,
				appendSystemPromptOverride: (base) => [
					...base,
					[prompt?.trim(), subagentInstruction].filter(Boolean).join("\n\n"),
				],
			});
			await loader.reload();

			const customTools: ToolDefinition[] = run.allowIntercom
				? createChildTools(task.id, this.makeChildHandlers(run, task, ctx))
				: [];

			const created = await createAgentSession({
				cwd: childCwd,
				agentDir: getAgentDir(),
				modelRuntime: await createChildModelRuntime(ctx),
				resourceLoader: loader,
				sessionManager: SessionManager.create(childCwd, undefined, { parentSession: getParentSessionFile(ctx) }),
				model,
				thinkingLevel: thinking as ThinkingLevel | undefined,
				tools,
				customTools,
			});
			child = created.session;
			child.setSessionName?.(`subagent: ${task.agent}`);
			this.updateTask(
				run,
				task,
				{ status: "running", sessionId: child.sessionId, sessionFile: child.sessionFile },
				ctx,
				onUpdate,
			);

			const childFailurePromise = new Promise<never>((_, reject) => {
				childState.failChildEnd = reject;
			});
			const childEndPromise = new Promise<void>((resolve) => {
				childState.childEndResolve = resolve;
			});

			unsubscribe = child.subscribe((event: AgentSessionEvent) =>
				this.onChildEvent(event, run, task, ctx, onUpdate, watchdog, childState),
			);

			const abortChild = () => {
				void child?.abort();
				this.runControllers.get(run.id)?.abort(); // parent abort kills ALL siblings, not just this child
			};
			const runController = this.runControllers.get(run.id);
			if (signal) signal.addEventListener("abort", abortChild, { once: true });
			if (runController) runController.signal.addEventListener("abort", abortChild, { once: true });
			abortListener = () => {
				signal?.removeEventListener("abort", abortChild);
				runController?.signal.removeEventListener("abort", abortChild);
			};
			// Cancel may have landed during session creation — honor it before prompting.
			if (run.status === "aborted" || TERMINAL.includes(task.status) || signal?.aborted) {
				await child.abort();
				throw new Error("Canceled by subagent_cancel");
			}
			this.liveChildren.set(key, {
				abort: () => void child?.abort(),
				dispose: () => watchdog.dispose(),
				touchWatchdog: () => watchdog.touch(),
				// Inject a steering message mid-run; queues as steer if the child is streaming.
				steer: (message) =>
					void child?.prompt(message, { streamingBehavior: "steer" }).catch((err) =>
						this.pi.sendUserMessage(`[steer_subagent] ${err instanceof Error ? err.message : String(err)}`, {
							deliverAs: "followUp",
						}),
					),
			});

			// auto-limit off = strip leader-imposed caps; tasks run unlimited until done.
			const maxRuntimeMs = this.autoLimit ? (input.maxRuntimeMs ?? DEFAULT_RUNTIME_MS) : 0;
			const promptPromise = child.prompt(task.task, { source: "extension" });
			const races: Promise<unknown>[] = [promptPromise, childFailurePromise, childEndPromise, watchdog.promise];
			if (maxRuntimeMs > 0) {
				races.push(
					new Promise<never>((_, reject) => {
						timeout = setTimeout(() => reject(new Error(`Subagent timed out after ${maxRuntimeMs}ms`)), maxRuntimeMs);
					}),
				);
			}
			await Promise.race(races);
			if (timeout) clearTimeout(timeout);

			childState.pendingFailure ??= lastAssistantFailure(child.messages as AssistantMessage[]);
			if (childState.pendingFailure) throw failureError(childState.pendingFailure);

			const finalText =
				task.finalText ||
				truncateText((child.messages as AssistantMessage[]).map(getFirstText).filter(Boolean).at(-1) || "");
			if (task.status !== "aborted") {
				this.updateTask(run, task, { status: "completed", finalText, endedAt: Date.now() }, ctx, onUpdate);
				if (wt) {
					// Commit the child's changes, then report the branch + diff so the
					// leader can review and merge (PR-style). The worktree dir stays
					// until the branch is merged — cleanupMerged removes both then.
					// Commit/diff failures must NOT downgrade a completed task or destroy
					// its work: the error is reported, the status stays completed.
					let committed: "committed" | "empty" | undefined;
					try {
						committed = commitWorktree(wt, `subagent ${task.agent}: ${truncateText(input.task, 60)}`);
						// Only a real commit is worth a branch: an empty one would send the
						// leader off to review and merge nothing.
						keepWorktreeDir = committed === "committed";
					} catch (commitErr) {
						// Never drop a checkout whose work isn't on the branch — it would be
						// unreachable once the base-tip branch is reaped as "merged".
						keepWorktreeDir = true;
						this.updateTask(
							run,
							task,
							{
								branch: wt.branch,
								worktreeError: `commit failed (uncommitted changes remain in ${wt.path}): ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`,
							},
							ctx,
							onUpdate,
						);
					}
					// Diff separately: a diff failure must not be reported as a lost commit.
					if (committed === "committed") {
						try {
							const { stat, files } = branchDiff(wt);
							this.updateTask(
								run,
								task,
								{ branch: wt.branch, diffStat: stat || undefined, changedFiles: files.length ? files : undefined },
								ctx,
								onUpdate,
							);
						} catch (diffErr) {
							this.updateTask(
								run,
								task,
								{
									branch: wt.branch,
									worktreeError: `committed, but the diff could not be read: ${diffErr instanceof Error ? diffErr.message : String(diffErr)}`,
								},
								ctx,
								onUpdate,
							);
						}
					}
				}
			}
		} catch (err) {
			if (timeout) clearTimeout(timeout);
			// Cancel is authoritative: parent tool signal OR run/task already marked aborted.
			const aborted = signal?.aborted || run.status === "aborted" || task.status === "aborted";
			const subagentStatus = (err as Error & { subagentStatus?: string })?.subagentStatus;
			try {
				// Unblock a child stuck in ask_parent, then time-box the abort so a
				// wedged session can never hang this catch/finally.
				this.pendingReplies.get(key)?.resolve("(parent unreachable)");
				await Promise.race([child?.abort(), new Promise((r) => setTimeout(r, 5000))]);
			} catch {
				/* ignore */
			}
			this.updateTask(
				run,
				task,
				{
					status: aborted ? "aborted" : ((subagentStatus as TaskStatus) ?? "failed"),
					error: err instanceof Error ? err.message : String(err),
					endedAt: Date.now(),
				},
				ctx,
				onUpdate,
			);
		} finally {
			this.liveChildren.delete(key);
			this.pendingReplies.delete(key);
			abortListener?.();
			unsubscribe?.();
			watchdog.dispose();
			if (timeout) clearTimeout(timeout);
			child?.dispose();
			// Failed/aborted: let the aborted child's last writes land (its tools may
			// still be unwinding), commit whatever partial work exists so the branch
			// really keeps it, then drop the checkout dir. A commit FAILURE keeps the
			// dir — dropping it would make the work unreachable.
			if (wt && task.status !== "completed") {
				await new Promise((r) => setTimeout(r, 250));
				let partial: "committed" | "empty" | undefined;
				try {
					partial = commitWorktree(wt, `subagent ${task.agent} (partial, ${task.status})`);
				} catch {
					keepWorktreeDir = true; // work exists only in the dir — keep it
				}
				// A branch is only worth reporting when it actually carries something.
				if (partial === "committed" || keepWorktreeDir) {
					this.updateTask(run, task, { branch: wt.branch }, ctx, onUpdate);
				}
			}
			if (wt && !keepWorktreeDir) removeWorktree(wt);
			// Released only after the dir is gone: while it exists, the branch must stay
			// in liveBranches() so cleanup can't reap it.
			this.liveWorktrees.delete(key);
		}
	}

	// ── run lifecycle ───────────────────────────────────────────────────
	createRun(params: SubagentParamsShape, ctx: ExtensionContext): { run: RunSnapshot; inputs: TaskInput[] } {
		const hasChain = (params.chain?.length ?? 0) > 0;
		const hasTasks = (params.tasks?.length ?? 0) > 0;
		// An array mode wins over stray top-level agent/task: models routinely leave
		// those in place when switching to tasks:[...], and the intent is not
		// ambiguous — rejecting a well-formed 3-task call over leftovers is worse
		// than ignoring them. Genuine ambiguity (tasks AND chain) is still refused.
		const hasSingle = !hasChain && !hasTasks && Boolean(params.agent && params.task);
		if (hasChain && hasTasks) {
			throw new Error(`Provide either tasks (parallel) or chain (sequential), not both.`);
		}
		if (!hasChain && !hasTasks && !hasSingle) {
			throw new Error(
				`Provide one subagent mode: agent+task (single), tasks: [...] (parallel), or chain: [...] (sequential).`,
			);
		}

		const mode: RunMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
		const inputs: TaskInput[] = hasSingle
			? [
					{
						agent: params.agent as string,
						task: params.task as string,
						prompt: params.prompt,
						write: params.write,
						model: params.model,
						thinking: params.thinking,
						cwd: params.cwd,
						tools: params.tools,
						maxRuntimeMs: params.maxRuntimeMs,
					},
				]
			: hasTasks
				? params.tasks!
				: params.chain!;
		if (inputs.length > MAX_TASKS) throw new Error(`Too many subagent tasks (${inputs.length}). Max is ${MAX_TASKS}.`);
		// Task ids become git refs + filesystem paths — refuse anything unsafe.
		// Explicit ids are checked against each other; generated ones are checked
		// against explicit ones so a collision can't silently fall back to in-place.
		const ids = new Set<string>();
		for (const input of inputs) {
			if (input.id !== undefined) {
				if (!SAFE_TASK_ID.test(input.id)) {
					throw new Error(`Unsafe task id: "${input.id}" (allowed: letters, digits, _ and - only).`);
				}
				if (ids.has(input.id)) throw new Error(`Duplicate task id: ${input.id}`);
				ids.add(input.id);
			}
		}
		for (let i = 0; i < inputs.length; i++) {
			const generated = `task_${i + 1}`;
			if (inputs[i]?.id === undefined && ids.has(generated)) {
				throw new Error(`Generated task id ${generated} collides with an explicit id — rename the explicit id.`);
			}
		}
		const edges = resolveNeeds(inputs, mode);

		const run: RunSnapshot = {
			id: newId("run"),
			mode,
			status: "queued",
			allowIntercom: Boolean(params.allowIntercom),
			notifyPerTask: params.notifyPerTask ?? true,
			createdAt: Date.now(),
			concurrency: Math.max(1, Math.min(params.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY)),
			tasks: inputs.map((input, index) => ({
				id: input.id ?? `task_${index + 1}`,
				runId: "",
				agent: input.agent,
				task: input.task,
				cwd: input.cwd ?? ctx.cwd,
				status: "queued" as TaskStatus,
				needs: edges[index],
				model: input.model,
				thinking: input.thinking,
				tools: input.tools ?? (input.write ? WRITE_TOOLS : READONLY_TOOLS),
				toolCalls: 0,
				usage: emptyUsage(),
			})),
			aggregateUsage: emptyUsage(),
		};
		// Roster: each child learns its own address + sibling addresses so
		// send_agent_message/poll_agent_messages can be used reliably.
		const roster = run.tasks.map((t) => `${t.id} (${t.agent})`).join(", ");
		for (const task of run.tasks) {
			task.roster = roster;
		}
		run.tasks.forEach((t) => {
			t.runId = run.id;
		});
		this.turnActivity = true;
		this.runs.set(run.id, run);
		this.settlers.set(run.id, true);
		this.runControllers.set(run.id, new AbortController());
		for (const task of run.tasks) this.mailboxes.open(`${run.id}:${task.id}`);
		this.emit("subagent:run-created", { run: cloneRun(run) });
		return { run, inputs };
	}

	private async executeTasks(
		run: RunSnapshot,
		inputs: TaskInput[],
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onUpdate?: (partial: any) => void,
	): Promise<void> {
		run.status = "running";
		run.startedAt = Date.now();
		this.updateRun(run, ctx, onUpdate);

		// One wave scheduler for every mode. A wave is the set of tasks whose needs
		// are all satisfied; the loop boundary between waves IS the gate. Chain mode
		// reaches here as needs: [previous], so it needs no special case.
		const outputs = new Map<string, string>();
		const settled = new Set<string>();
		for (const task of run.tasks) {
			if (TERMINAL.includes(task.status)) settled.add(task.id); // canceled before start
		}
		// id → input, immune to filtered-array index drift (C4).
		const inputById = new Map(run.tasks.map((t, i) => [t.id, inputs[i]]));

		const { skipped } = await runWaveScheduler(
			run.tasks.filter((t) => !TERMINAL.includes(t.status)),
			run.mode === "single" ? 1 : run.concurrency,
			outputs,
			settled,
			async (task) => {
				// The scheduler passes the index into the FILTERED list — never use it
				// against the unfiltered inputs. Look the input up by task id instead.
				const input = inputById.get(task.id);
				if (!input) {
					// Impossible unless ids drift from inputs — fail loudly instead of
					// leaving the task queued forever (hasActiveRun would never clear).
					this.updateTask(
						run,
						task,
						{ status: "failed", error: `No input for task ${task.id}`, endedAt: Date.now() },
						ctx,
						onUpdate,
					);
					return;
				}
				await this.runChild(
					run,
					task,
					{ ...input, task: applyUpstream(input.task, task.needs ?? [], outputs) },
					ctx,
					signal,
					onUpdate,
				);
				if (task.status === "completed") outputs.set(task.id, task.finalText ?? "");
				if (run.notifyPerTask && TERMINAL.includes(task.status)) {
					this.notifyTask(run, task, task.status as "completed" | "failed" | "aborted");
				}
			},
		);
		// Broken-upstream tasks are detected by the scheduler; mark them after the wave.
		for (const s of skipped) {
			const task = run.tasks.find((t) => t.id === s.id);
			if (task && !TERMINAL.includes(task.status)) {
				this.updateTask(
					run,
					task,
					{
						status: "aborted",
						// Don't overwrite a real reason (e.g. "Canceled by subagent_cancel").
						error: task.error || `Skipped: upstream task(s) did not complete: ${s.needs.join(", ")}`,
						endedAt: Date.now(),
					},
					ctx,
					onUpdate,
				);
			}
		}
		// Belt and braces: the wave loop breaks out when no frontier is ready, which
		// would otherwise leave tasks queued inside a terminal run — hasActiveRun()
		// then never clears and the widget stays pinned.
		for (const task of run.tasks) {
			if (TERMINAL.includes(task.status)) continue;
			this.updateTask(
				run,
				task,
				{ status: "aborted", error: task.error || "Never ran: no runnable wave", endedAt: Date.now() },
				ctx,
				onUpdate,
			);
		}

		const failed = run.tasks.some((t) => t.status === "failed");
		const aborted = run.tasks.some((t) => t.status === "aborted") || Boolean(signal?.aborted);
		run.status = aborted ? "aborted" : failed ? "failed" : "completed";
		run.endedAt = Date.now();
		this.flushWidget(run, ctx, onUpdate);
		// Finished runs (including aborted ones) stay on screen so the outcome is readable.
		// The agent_start handler clears them on the next turn that spawns nothing.
		const live = this.listRuns().find((r) => !TERMINAL.includes(r.status));
		if (live) this.scheduleWidget(live, ctx);
		// L7: cancelRun already emitted + settled — don't double-report.
		if (this.settlers.has(run.id)) {
			this.emit("subagent:run-completed", {
				runId: run.id,
				status: run.status,
				run: cloneRun(run),
				aggregateUsage: run.aggregateUsage,
			});
			this.settleRun(run.id, run);
		}
		this.runControllers.delete(run.id);
		for (const task of run.tasks) this.mailboxes.close(`${run.id}:${task.id}`);
		this.persist(ctx);
		// Branches merged by the leader since the run ended: drop worktree dir + branch.
		// Once per repo, never for a branch another live run owns, never fatal — a
		// throw here would re-settle an already-finished run as failed.
		try {
			const roots = new Set<string>();
			for (const task of run.tasks) {
				if (!task.branch) continue;
				const root = repoRoot(task.cwd);
				if (root) roots.add(root);
			}
			for (const root of roots) cleanupMerged(root, { skipBranches: this.liveBranches() });
		} catch {
			/* cleanup is best-effort; the run outcome must stand */
		}
	}

	/** Branches owned by worktrees of still-running children. */
	liveBranches(): Set<string> {
		return new Set(Array.from(this.liveWorktrees.values(), (wt) => wt.branch));
	}

	/** Spawn a run that keeps executing after this call returns. Every run is background. */
	startInBackground(params: SubagentParamsShape, ctx: ExtensionContext): RunDetails {
		const { run, inputs } = this.createRun(params, ctx);
		void this.executeTasks(run, inputs, ctx, undefined, undefined)
			.then(() => {
				this.notifyParent(
					run,
					run.status === "completed" ? "completed" : run.status === "aborted" ? "aborted" : "failed",
				);
			})
			.catch((err) => {
				// Never leave a background run unsettled: mark failed, settle, notify.
				run.status = "failed";
				run.endedAt = Date.now();
				for (const task of run.tasks) {
					if (!TERMINAL.includes(task.status)) {
						task.status = "failed";
						task.error = task.error || String(err instanceof Error ? err.message : err);
						task.endedAt = Date.now();
					}
				}
				this.settleRun(run.id, run);
				this.runControllers.delete(run.id);
				for (const task of run.tasks) this.mailboxes.close(`${run.id}:${task.id}`);
				this.emit("subagent:run-completed", { runId: run.id, status: "failed", run: cloneRun(run) });
				this.notifyParent(run, "failed");
				this.persist(ctx);
			});
		return { run: cloneRun(run) };
	}

	/** Push a steering message into a live child's session. Returns false when unknown or not running. */
	steerTask(runId: string, taskId: string | undefined, message: string): boolean {
		const run = this.runs.get(runId);
		if (!run) return false;
		const ids = taskId ? [taskId] : run.tasks.map((t) => t.id).filter((id) => this.liveChildren.has(`${runId}:${id}`));
		if (ids.length === 0) return false;
		for (const id of ids) this.liveChildren.get(`${runId}:${id}`)?.steer(message);
		return true;
	}

	/** Abort ONE task; siblings keep running. Returns false when unknown or already finished. */
	cancelTask(runId: string, taskId: string, ctx?: ExtensionContext): boolean {
		const run = this.runs.get(runId);
		const task = run?.tasks.find((t) => t.id === taskId);
		if (!run || !task || TERMINAL.includes(task.status)) return false;
		// Mark first: runChild's catch reads task.status to classify the outcome as aborted.
		task.status = "aborted";
		task.error = task.error || "Canceled from peek";
		task.endedAt = Date.now();
		this.pendingReplies.get(`${runId}:${taskId}`)?.resolve("(task canceled by the parent — stop work now)");
		this.pendingReplies.delete(`${runId}:${taskId}`);
		this.liveChildren.get(`${runId}:${taskId}`)?.abort();
		this.mailboxes.close(`${runId}:${taskId}`);
		if (ctx) this.flushWidget(run, ctx);
		this.emit("subagent:task-aborted", { runId, taskId });
		return true;
	}

	cancelRun(runId: string): { aborted: number } {
		const run = this.runs.get(runId);
		if (!run) return { aborted: 0 };
		if (TERMINAL.includes(run.status)) return { aborted: 0 }; // never corrupt a finished run
		let aborted = 0;
		this.runControllers.get(runId)?.abort();
		// Release children parked in ask_parent first — an unresolved wait would keep
		// the child alive past the abort.
		for (const [key, pending] of this.pendingReplies) {
			if (key.startsWith(`${runId}:`)) {
				this.pendingReplies.delete(key);
				pending.resolve("(run canceled by the parent — stop work and return what you have)");
			}
		}
		for (const [key, child] of this.liveChildren) {
			if (key.startsWith(`${runId}:`)) {
				child.abort();
			}
		}
		for (const task of run.tasks) {
			if (TERMINAL.includes(task.status)) continue;
			task.status = "aborted";
			task.error = task.error || "Canceled by subagent_cancel"; // never overwrite a real error
			task.endedAt = Date.now();
			aborted += 1;
			// The branch is recorded here so the leader can still merge partial work;
			// runChild's finally commits + drops the dir (it owns the live worktree).
			const wt = this.liveWorktrees.get(`${runId}:${task.id}`);
			if (wt) task.branch = wt.branch;
		}
		run.status = "aborted";
		run.endedAt = Date.now();
		this.settleRun(runId, run);
		this.runControllers.delete(runId);
		for (const task of run.tasks) this.mailboxes.close(`${run.id}:${task.id}`);
		this.emit("subagent:run-completed", { runId: run.id, status: "aborted", run: cloneRun(run) });
		return { aborted };
	}

	/** Settle-and-delete: every awaiter resolves once, then the set is dropped. */
	private settleRun(runId: string, run: RunSnapshot): void {
		if (!this.settlers.has(runId)) return;
		this.settlers.delete(runId);
		const waiters = this.settleWaiters.get(runId);
		this.settleWaiters.delete(runId);
		if (!waiters) return;
		const snapshot = cloneRun(run);
		for (const waiter of waiters) waiter(snapshot);
	}

	/** Child→leader messages collected while the parent is parked in await_subagent. */
	/** Every awaiter parked on a run — a SET, so two concurrent awaits can't
	 *  overwrite each other's buffer and silently swallow one side's intercom. */
	private parked = new Map<string, Set<{ msgs: ParkedMsg[]; wake: () => void }>>();

	/** While the parent is parked on this run, deliver the message through the wait instead of the steering queue. */
	private collectParked(runId: string, msg: ParkedMsg): boolean {
		const parked = this.parked.get(runId);
		if (!parked || parked.size === 0) return false;
		let delivered = false;
		for (const p of parked) {
			if (p.msgs.length < PARKED_MSG_CAP) {
				p.msgs.push(msg);
				delivered = true;
			} else if (msg.kind === "ask") {
				// An unanswered ask blocks a child for 10 minutes — it must never be the
				// message that gets dropped by the cap. Evict the oldest NON-ask first
				// (asks already block children; displacing one hangs the earlier asker).
				const drop = p.msgs.findIndex((m) => m.kind !== "ask");
				if (drop !== -1) {
					p.msgs.splice(drop, 1);
					p.msgs.push(msg);
				} else {
					p.msgs[p.msgs.length - 1] = msg; // all asks — overwrite the oldest ask
				}
				delivered = true;
			}
			p.wake(); // resolve the parked await early — the leader breathes on every message
		}
		// Not buffered anywhere → report undelivered so the caller falls back to a
		// followUp notice instead of assuming the leader saw it.
		return delivered;
	}

	awaitRun(
		runId: string,
		timeoutMs?: number,
	): Promise<{ run: RunSnapshot | undefined; intercom: ParkedMsg[] } | undefined> {
		const run = this.runs.get(runId);
		if (!run) return Promise.resolve(undefined);
		let entry: { msgs: ParkedMsg[]; wake: () => void } | undefined;
		const finish = (): void => {
			const parked = this.parked.get(runId);
			if (!parked || !entry) return;
			parked.delete(entry); // only our own park — a sibling await keeps receiving
			if (parked.size === 0) this.parked.delete(runId);
		};
		if (TERMINAL.includes(run.status)) {
			run.awaited = true;
			return Promise.resolve({ run: cloneRun(run), intercom: [] });
		}
		const msgs: ParkedMsg[] = [];
		const settled = new Promise<RunSnapshot | undefined>((resolve) => {
			// Waiters are a SET, not a chain: the autoAwait loop re-parks on every
			// child message, and wrapping the previous settler each time grew an
			// unbounded closure chain (each holding a snapshot clone).
			const waiter = (r: RunSnapshot) => {
				this.settleWaiters.get(runId)?.delete(waiter);
				resolve(r);
			};
			let waiters = this.settleWaiters.get(runId);
			if (!waiters) {
				waiters = new Set();
				this.settleWaiters.set(runId, waiters);
			}
			waiters.add(waiter);
			// A child→leader message while parked wakes the wait: the leader gets it
			// IN the await result, no steering queue, no turn boundary needed.
			entry = { msgs, wake: () => waiter(cloneRun(run)) };
			let parked = this.parked.get(runId);
			if (!parked) {
				parked = new Set();
				this.parked.set(runId, parked);
			}
			parked.add(entry);
		});
		if (timeoutMs !== undefined && timeoutMs > 0) {
			let timedOut = false;
			return Promise.race([
				settled.then((r) => {
					finish();
					// Only mark awaited when this call actually hands the run back to the
					// leader. A slice that already timed out is abandoned — setting it here
					// would suppress the run's completion notice the leader still needs.
					if (!timedOut) run.awaited = true;
					return { run: r, intercom: msgs };
				}),
				new Promise<{ run: RunSnapshot | undefined; intercom: ParkedMsg[] } | undefined>((resolve) => {
					const timer = setTimeout(() => {
						timedOut = true;
						finish();
						resolve(this.runs.get(runId) ? { run: cloneRun(this.runs.get(runId)!), intercom: msgs } : undefined);
					}, timeoutMs);
					settled.then(() => clearTimeout(timer));
				}),
			]);
		}
		return settled.then((r) => {
			finish();
			run.awaited = true;
			return { run: r, intercom: msgs };
		});
	}
}
