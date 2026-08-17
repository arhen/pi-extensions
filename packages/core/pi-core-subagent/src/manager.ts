/** SubagentManager: run lifecycle, child sessions, intercom, persistence, widget plumbing. */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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

export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 8;
/** No default wall-clock cap: a subagent runs until its task is done, it stalls, or the user aborts. */
export const DEFAULT_RUNTIME_MS = 0;
export const DEFAULT_STALL_MS = 180_000; // 3 min: long model thinking streams emit no events, but they're not stalled.
export const READONLY_TOOLS = ["read", "grep", "find", "ls"];
export const WRITE_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const WIDGET_THROTTLE_MS = 150;

// ── helpers ──────────────────────────────────────────────────────────────

export function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}
export function aggregateUsage(tasks: TaskSnapshot[]): UsageStats {
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
export function getParentSessionFile(ctx: ExtensionContext): string | undefined {
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
export function lastAssistantFailure(
	messages: AssistantMessage[] | undefined,
): { status: "failed" | "aborted"; message: string } | undefined {
	for (const message of [...(messages ?? [])].reverse()) {
		if (message?.role !== "assistant") continue;
		return classifyFailure(message.stopReason, message.errorMessage);
	}
	return undefined;
}
export function failureError(failure: { status: "failed" | "aborted"; message: string }): Error {
	const error = new Error(failure.message);
	(error as Error & { subagentStatus?: string }).subagentStatus = failure.status;
	return error;
}
export function updateUsageFromMessage(task: TaskSnapshot, message: AssistantMessage): void {
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
	private settlers = new Map<string, (run: RunSnapshot) => void>();
	private pendingReplies = new Map<string, PendingReply>();
	private liveChildren = new Map<
		string,
		{ abort: () => void; dispose: () => void; touchWatchdog: () => void; steer: (message: string) => void }
	>();
	private mailboxes: Mailbox = createMailbox();
	private runControllers = new Map<string, AbortController>();
	private widgetTimers = new Map<string, ReturnType<typeof setTimeout>>(); // per-run stream throttle
	private widgetRuns: RunSnapshot[] = [];
	private eventSeq = 0;

	/** Default for `background` when the agent doesn't say — toggle via `/subagents auto-bg on|off`. */
	private autoBg = true;

	/** When false, strip leader-imposed maxRuntimeMs so tasks run unlimited — toggle via `/subagents auto-limit on|off`. */
	private autoLimit = true;

	turnActivity = false;

	constructor(private readonly pi: ExtensionAPI) {
		try {
			const cfg = JSON.parse(readFileSync(join(getAgentDir(), "subagents-config.json"), "utf8"));
			if (typeof cfg.autoBg === "boolean") this.autoBg = cfg.autoBg;
			if (typeof cfg.autoLimit === "boolean") this.autoLimit = cfg.autoLimit;
		} catch {
			/* no config yet — defaults */
		}
	}

	/** Flip the background-by-default flag; persists to the agent dir. Returns the new value. */
	setAutoBg(on: boolean): boolean {
		this.autoBg = on;
		void writeFile(
			join(getAgentDir(), "subagents-config.json"),
			JSON.stringify({ autoBg: on, autoLimit: this.autoLimit }, null, 2),
		).catch(() => {});
		return on;
	}

	/** Flip the auto-limit flag; persists to the agent dir. Returns the new value. */
	setAutoLimit(on: boolean): boolean {
		this.autoLimit = on;
		void writeFile(
			join(getAgentDir(), "subagents-config.json"),
			JSON.stringify({ autoBg: this.autoBg, autoLimit: on }, null, 2),
		).catch(() => {});
		return on;
	}

	get autoBgOn(): boolean {
		return this.autoBg;
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
		this.runs.clear();
		this.settlers.clear();
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
			void writeFile(sidecar, JSON.stringify(this.listRuns().slice(0, 50).map(cloneRun), null, 2)).catch(() => {}); // never surface as an unhandled rejection
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
				? `A background subagent is asking you a question (task ${extra?.taskId}): ${extra?.question ?? ""}\nReply with reply_subagent(runId: "${run.id}", taskId: "${extra?.taskId}", message: ...).`
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
				this.updateTask(run, task, { status: "awaiting_parent" }, ctx);
				this.liveChildren.get(`${run.id}:${task.id}`)?.touchWatchdog();
				// While the leader is parked in await_subagent, the question rides the wait
				// instead of the steering queue — no boundary needed, no starvation.
				if (this.collectParked(run.id, { kind: "ask", taskId: task.id, agent: task.agent, text: question })) {
					return "Your question was delivered to the parent (they're waiting on this run). Keep working; the answer arrives via the pending reply.";
				}
				// A blocking run's parent can't reply mid-tool (followUp only fires after the
				// tool returns) — only background runs can truly wait for the answer.
				if (!run.background) {
					this.updateTask(run, task, { status: "running" }, ctx);
					this.liveChildren.get(`${run.id}:${task.id}`)?.touchWatchdog();
					return "Parent cannot answer while this run is blocking. Continue autonomously with your best judgment.";
				}
				this.notifyParent(run, "asked", { taskId: task.id, question });
				// M3: a waiting child is not stalled — keep the watchdog fed until the reply.
				const keepAlive = setInterval(() => this.liveChildren.get(`${run.id}:${task.id}`)?.touchWatchdog(), 30_000);
				try {
					const reply = await this.awaitParentReply(run.id, task.id);
					this.updateTask(run, task, { status: "running" }, ctx);
					this.liveChildren.get(`${run.id}:${task.id}`)?.touchWatchdog();
					return reply;
				} finally {
					clearInterval(keepAlive);
				}
			},
			onNotifyParent: (_taskId, message, level) => {
				this.emit("subagent:intercom", { runId: run.id, taskId: task.id, kind: "notify", level, message });
				if (this.collectParked(run.id, { kind: "notify", taskId: task.id, agent: task.agent, text: message })) return;
				if (!run.awaited) {
					try {
						this.pi.sendUserMessage(`[Subagent ${task.agent}] ${message}`, { deliverAs: "followUp" });
					} catch {
						/* parent mid-stream */
					}
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
					if (!run.awaited) {
						try {
							this.pi.sendUserMessage(`[Subagent ${task.agent}] ${text}`, { deliverAs: "followUp" });
						} catch {
							/* parent mid-stream */
						}
					}
					return true;
				}
				// Run-scoped keys: sibling ids are run-local; cross-run task_1 can never collide.
				return this.mailboxes.send(`${run.id}:${task.id}`, `${run.id}:${to}`, text);
			},
			onPollMailbox: (taskId) => this.mailboxes.poll(`${run.id}:${taskId}`),
		};
	}
	private awaitParentReply(runId: string, taskId: string): Promise<string> {
		return new Promise<string>((resolve) => {
			this.pendingReplies.set(`${runId}:${taskId}`, { resolve });
		});
	}
	deliverReply(runId: string, taskId: string, message: string): boolean {
		const pending = this.pendingReplies.get(`${runId}:${taskId}`);
		if (!pending) return false;
		this.pendingReplies.delete(`${runId}:${taskId}`);
		pending.resolve(message);
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

		// Inline params win; otherwise fall back to an existing agent file
		// (~/.agents, .pi/agents, user dir). Never creates files.
		const prompt = input.prompt?.trim();
		const thinking = input.thinking;
		const baseTools = input.tools ?? (input.write ? WRITE_TOOLS : READONLY_TOOLS);
		const tools = [...baseTools, ...(run.allowIntercom ? CHILD_TALK_TOOLS : [])];

		// Model + thinking resolve against the pi model registry; a bad request
		// fails the TASK with a helpful message, not the whole run.
		let model: Model<Api> | undefined;
		try {
			model = resolveChildModel(ctx, input.model);
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

		let child: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let unsubscribe: (() => void) | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;
		const watchdog = createWatchdog(DEFAULT_STALL_MS, `Subagent ${task.agent}`);
		const childState: ChildEventState = {};

		const key = `${run.id}:${task.id}`;
		try {
			const subagentInstruction = run.allowIntercom
				? `You are running as a subagent. Your bash tool already executes in the project working directory — never prefix commands with \`cd\`. Do not call subagent/delegation tools unless the parent explicitly asks. Return a concise final answer. You MAY use ask_parent only when truly blocked on information only the parent has; notify_parent for one-way updates; send_agent_message/poll_agent_messages to coordinate with siblings. Your mailbox address and siblings: ${task.roster ?? "(none)"}. Use the exact task ids (e.g. task_2) as send_agent_message targets. Siblings run independently and may start late or finish early — never block indefinitely on their replies: poll at most 5 times, then proceed with your best judgment. A gated sibling (marked ↳ waits in the graph) may not be running yet; do not wait for it. Stalled waits get the whole run killed. When your work is done, call notify_parent ONCE with a concise result summary — key findings, verdicts, file:line evidence — so the leader can start consuming your output before the run finishes.`
				: `You are running as a subagent. Your bash tool already executes in the project working directory — never prefix commands with \`cd\`. Do not call subagent/delegation tools unless the parent explicitly asks. Return a concise final answer for the parent agent.`;

			const loader = new DefaultResourceLoader({
				cwd: task.cwd,
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
				cwd: task.cwd,
				agentDir: getAgentDir(),
				modelRuntime: await createChildModelRuntime(ctx),
				resourceLoader: loader,
				sessionManager: SessionManager.create(task.cwd, undefined, { parentSession: getParentSessionFile(ctx) }),
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
		}
	}

	// ── run lifecycle ───────────────────────────────────────────────────
	createRun(params: SubagentParamsShape, ctx: ExtensionContext): { run: RunSnapshot; inputs: TaskInput[] } {
		const hasChain = (params.chain?.length ?? 0) > 0;
		const hasTasks = (params.tasks?.length ?? 0) > 0;
		const hasSingle = Boolean(params.agent && params.task);
		if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
			throw new Error(`Provide exactly one subagent mode (single, tasks, or chain).`);
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
		const ids = new Set<string>();
		for (const input of inputs) {
			if (input.id !== undefined) {
				if (ids.has(input.id)) throw new Error(`Duplicate task id: ${input.id}`);
				ids.add(input.id);
			}
		}
		const edges = resolveNeeds(inputs, mode);

		const run: RunSnapshot = {
			id: newId("run"),
			mode,
			status: "queued",
			background: params.background ?? this.autoBg,
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
		this.settlers.set(run.id, () => {});
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

		const { skipped } = await runWaveScheduler(
			run.tasks.filter((t) => !TERMINAL.includes(t.status)),
			run.mode === "single" ? 1 : run.concurrency,
			outputs,
			settled,
			async (task, index) => {
				const input = inputs[index]!;
				await this.runChild(
					run,
					task,
					{ ...input, task: applyUpstream(input.task, task.needs ?? [], outputs) },
					ctx,
					signal,
					onUpdate,
				);
				if (task.status === "completed") outputs.set(task.id, task.finalText ?? "");
				if (run.notifyPerTask && run.background && TERMINAL.includes(task.status)) {
					this.notifyTask(run, task, task.status as "completed" | "failed" | "aborted");
				}
			},
		);
		// Broken-upstream tasks are detected by the scheduler; mark them after the wave.
		for (const s of skipped) {
			const task = run.tasks.find((t) => t.id === s.id);
			if (task) {
				this.updateTask(
					run,
					task,
					{
						status: "aborted",
						error: `Skipped: upstream task(s) did not complete: ${s.needs.join(", ")}`,
						endedAt: Date.now(),
					},
					ctx,
					onUpdate,
				);
			}
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
	}

	async runBlocking(
		params: SubagentParamsShape,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: any) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<RunDetails> {
		const { run, inputs } = this.createRun(params, ctx);
		await this.executeTasks(run, inputs, ctx, signal, onUpdate);
		return { run: cloneRun(run) };
	}

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
		return { run: cloneRun(run), background: true };
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
		}
		run.status = "aborted";
		run.endedAt = Date.now();
		this.settleRun(runId, run);
		this.runControllers.delete(runId);
		for (const task of run.tasks) this.mailboxes.close(`${run.id}:${task.id}`);
		this.emit("subagent:run-completed", { runId: run.id, status: "aborted", run: cloneRun(run) });
		return { aborted };
	}

	/** Settle-and-delete: awaiters resolve once; no leak, no closure chain. */
	private settleRun(runId: string, run: RunSnapshot): void {
		const s = this.settlers.get(runId);
		if (!s) return;
		this.settlers.delete(runId);
		s(cloneRun(run));
	}

	/** Child→leader messages collected while the parent is parked in await_subagent. */
	/** Child→leader messages collected while the parent is parked in await_subagent. */
	private parked = new Map<string, { msgs: ParkedMsg[]; wake: () => void }>();

	/** While the parent is parked on this run, deliver the message through the wait instead of the steering queue. */
	private collectParked(runId: string, msg: ParkedMsg): boolean {
		const p = this.parked.get(runId);
		if (!p) return false;
		if (p.msgs.length < 24) p.msgs.push(msg);
		p.wake(); // resolve the parked await early — the leader breathes on every message
		return true;
	}

	awaitRun(
		runId: string,
		timeoutMs?: number,
	): Promise<{ run: RunSnapshot | undefined; intercom: ParkedMsg[] } | undefined> {
		const run = this.runs.get(runId);
		if (!run) return Promise.resolve(undefined);
		const finish = (): void => {
			this.parked.delete(runId);
		};
		if (TERMINAL.includes(run.status)) {
			run.awaited = true;
			return Promise.resolve({ run: cloneRun(run), intercom: [] });
		}
		const msgs: ParkedMsg[] = [];
		const settled = new Promise<RunSnapshot | undefined>((resolve) => {
			const prev = this.settlers.get(runId);
			this.settlers.set(runId, (r) => {
				prev?.(r);
				resolve(r);
			});
			// A child→leader message while parked wakes the wait: the leader gets it
			// IN the await result, no steering queue, no turn boundary needed.
			this.parked.set(runId, { msgs, wake: () => resolve(cloneRun(run)) });
		});
		if (timeoutMs) {
			return Promise.race([
				settled.then((r) => {
					finish();
					run.awaited = true;
					return { run: r, intercom: msgs };
				}),
				new Promise<{ run: RunSnapshot | undefined; intercom: ParkedMsg[] } | undefined>((resolve) => {
					const timer = setTimeout(() => {
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
