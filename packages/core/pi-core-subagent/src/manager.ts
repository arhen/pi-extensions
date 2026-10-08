import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { resolveAgentFile } from "./agentfile.ts";
import { CHILD_TALK_TOOLS, type ChildHandlers, createChildTools } from "./child.ts";
import { readSubagentConfig, writeSubagentConfig } from "./config.ts";
import { LeaderDelivery } from "./delivery.ts";
import { activitySnippet, describeCall, getFirstText, truncateText } from "./format.ts";
import { applyUpstream, resolveNeeds, runWaveScheduler } from "./graph.ts";
import { createMailbox, type Mailbox } from "./mailbox.ts";
import { chooseModel, resolveChildModel } from "./models.ts";
import { textFingerprint } from "./notification-state.ts";
import {
	aggregateUsage,
	classifyFailure,
	cloneRun,
	emptyUsage,
	failureError,
	lastAssistantFailure,
	updateUsageFromMessage,
} from "./outcome.ts";
import { RunWidget } from "./run-widget.ts";
import {
	clampResumeThinking,
	codemodeFactories,
	createChildModelRuntime,
	ensureUsableModel,
	validateThinking,
} from "./runtime.ts";
import type { SubagentParamsShape, TaskInput } from "./schemas.ts";
import {
	MAX_TASKS,
	type ParkedMsg,
	type PendingReply,
	type RunDetails,
	type RunMode,
	type RunSnapshot,
	type RunStatus,
	type TaskSnapshot,
	type TaskStatus,
	TERMINAL,
} from "./types.ts";
import {
	attachWorktree,
	branchDiff,
	claimWorktree,
	cleanupMerged,
	commitWorktree,
	createWorktree,
	removeWorktree,
	repoRoot,
	type Worktree,
} from "./worktree.ts";

export type { ParkedMsg };
/** Legacy callers import these from here; their owners are `models.ts`, `outcome.ts`, `runtime.ts`. */
export { clampResumeThinking, classifyFailure, cloneRun, ensureUsableModel, resolveChildModel, validateThinking };

export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 8;
const DEFAULT_RUNTIME_MS = 3_600_000;
const UNLIMITED_RUNTIME_MS = 21_600_000;
const PARENT_REPLY_TIMEOUT_MS = 600_000;
const PARKED_MSG_CAP = 24;
const READONLY_TOOLS = ["read", "grep", "find", "ls", "codemode"];
const WRITE_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "codemode"];
const WRITE_CAPABLE = ["bash", "edit", "write"];
const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

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

interface ResumeInput {
	sessionFile: string;
	branch?: string;
	message: string;
}

interface ChildEventState {
	pendingFailure?: ReturnType<typeof classifyFailure>;
	failChildEnd?: (error: Error) => void;
	childEndResolve?: () => void;
}

export class SubagentManager {
	private runs = new Map<string, RunSnapshot>();
	private settlers = new Map<string, true>();
	private settleWaiters = new Map<string, Set<(run: RunSnapshot) => void>>();
	private pendingReplies = new Map<string, PendingReply>();
	private liveChildren = new Map<
		string,
		{ abort: () => void; dispose: () => void; steer: (message: string) => void }
	>();
	private mailboxes: Mailbox = createMailbox();
	private liveWorktrees = new Map<string, Worktree>();
	private runControllers = new Map<string, AbortController>();
	private readonly widget = new RunWidget();
	private readonly delivery: LeaderDelivery;
	private eventSeq = 0;
	private persistSeq = 0;
	private persistedSeq = 0;
	private persistChain: Promise<unknown> = Promise.resolve();
	private readonly instanceNonce = Math.random().toString(36).slice(2, 8);
	private cleared = false;

	private autoLimit = false;

	turnActivity = false;

	constructor(private readonly pi: ExtensionAPI) {
		this.delivery = new LeaderDelivery({
			pi,
			isCleared: () => this.cleared,
			findRun: (runId) => this.runs.get(runId),
			isLive: (key) => this.liveChildren.has(key),
			persist: (ctx) => this.persist(ctx),
			emit: (type, payload) => this.emit(type, payload),
			collectParked: (runId, msg) => this.collectParked(runId, msg),
		});
		try {
			const cfg = readSubagentConfig();
			if (typeof cfg.autoLimit === "boolean") this.autoLimit = cfg.autoLimit;
		} catch {}
	}

	setAutoLimit(on: boolean): boolean {
		this.autoLimit = on;
		void writeSubagentConfig({ autoLimit: on }).catch(() => {});
		return on;
	}

	get autoLimitOn(): boolean {
		return this.autoLimit;
	}

	hasActiveRun(): boolean {
		for (const run of this.runs.values()) {
			if (run.tasks.some((t) => !TERMINAL.includes(t.status))) return true;
		}
		return false;
	}

	clearWidget(ctx?: ExtensionContext): void {
		this.widget.clear(ctx);
	}

	/** Leader run started, ended or settled. */
	noteLeaderActivity(): void {
		this.delivery.noteLeaderActivity();
	}
	/** Pi's input stage saw a leader prompt; submitted notices it carries are no longer queued. */
	noteLeaderInput(text: string, source: string): void {
		this.delivery.noteLeaderInput(text, source);
	}
	markAwaitCoverage(run: RunSnapshot, coveredTaskIds?: ReadonlySet<string>): void {
		this.delivery.markAwaitCoverage(run, coveredTaskIds);
	}
	confirmLeaderMessages(ctx: ExtensionContext): void {
		this.delivery.confirmLeaderMessages(ctx);
	}
	flushPendingNotifications(ctx: ExtensionContext): void {
		this.delivery.flushPendingNotifications(ctx);
	}
	scheduleNotificationFlush(ctx: ExtensionContext, delayMs?: number): void {
		this.delivery.scheduleNotificationFlush(ctx, delayMs);
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

		for (const run of this.runs.values()) {
			for (const task of run.tasks) {
				if (!TERMINAL.includes(task.status)) {
					task.status = "aborted";
					task.error = task.error ?? "(session ended)";
				}
			}
		}

		for (const [runId, waiters] of this.settleWaiters) {
			const run = this.runs.get(runId);
			for (const waiter of waiters) waiter(run ? cloneRun(run) : ({ id: runId, status: "aborted" } as RunSnapshot));
		}
		for (const pending of this.pendingReplies.values()) {
			pending.resolve("(session ended — stop work immediately)");
		}
		this.parked.clear();
		this.delivery.reset();

		this.liveWorktrees.clear();
		this.runs.clear();
		this.settlers.clear();
		this.settleWaiters.clear();
		this.pendingReplies.clear();
		this.runControllers.clear();
		this.cleared = true;
		this.mailboxes = createMailbox();
		this.widget.dispose();
	}

	async restoreFromSidecar(ctx: ExtensionContext): Promise<void> {
		this.cleared = false;
		const parentFile = getParentSessionFile(ctx);
		if (!parentFile) return;
		const sidecar = parentFile.replace(/\.jsonl$/, ".subagents.json");
		let runs: RunSnapshot[];

		try {
			const dir = dirname(sidecar);
			const prefix = `${basename(sidecar)}.`;
			for (const entry of readdirSync(dir)) {
				if (entry.startsWith(prefix) && entry.endsWith(".tmp")) rmSync(join(dir, entry), { force: true });
			}
		} catch {}
		try {
			if (!existsSync(sidecar)) return;
			const raw = JSON.parse(readFileSync(sidecar, "utf-8"));
			if (!Array.isArray(raw)) return;
			runs = (raw as RunSnapshot[]).map((run) => {
				const interrupted = run.tasks.some((t) => !TERMINAL.includes(t.status));

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
			this.widget.schedule(this.listRuns()[0], ctx);
		}
	}
	private persist(ctx: ExtensionContext): void {
		if (this.cleared) return;
		try {
			const parentFile = getParentSessionFile(ctx);
			if (!parentFile) return;
			const sidecar = parentFile.replace(/\.jsonl$/, ".subagents.json");

			const seq = ++this.persistSeq;
			const tmp = `${sidecar}.${process.pid}.${this.instanceNonce}.${seq}.tmp`;
			const payload = JSON.stringify(this.listRuns().slice(0, 50).map(cloneRun), null, 2);

			this.persistChain = this.persistChain.then(async () => {
				if (seq < this.persistedSeq) return;
				try {
					await writeFile(tmp, payload);
					await rename(tmp, sidecar);
					this.persistedSeq = seq;
				} catch {
					await rm(tmp, { force: true }).catch(() => {});
				}
			});
		} catch {}
	}

	private emit(type: string, payload: Record<string, unknown>): void {
		this.pi.events.emit(type, { type, timestamp: Date.now(), ...payload });
	}

	private updateRun(run: RunSnapshot, ctx?: ExtensionContext, _onUpdate?: (partial: any) => void): void {
		run.aggregateUsage = aggregateUsage(run.tasks);
		this.runs.set(run.id, run);
		this.emit("subagent:run-updated", {
			runId: run.id,
			status: run.status,
			live: run.tasks.filter((t) => !TERMINAL.includes(t.status)).length,
		});
		this.widget.schedule(run, ctx);
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

	private makeChildHandlers(run: RunSnapshot, task: TaskSnapshot, ctx: ExtensionContext): ChildHandlers {
		this.delivery.notificationContext = ctx;
		return {
			onAskParent: async (_taskId, question, urgent) => {
				if (TERMINAL.includes(task.status)) {
					return "(your task has already ended — stop work and return immediately)";
				}
				this.updateTask(run, task, { status: "awaiting_parent" }, ctx);

				if (!this.collectParked(run.id, { kind: "ask", taskId: task.id, agent: task.agent, text: question })) {
					this.delivery.notifyParent(run, "asked", { taskId: task.id, agent: task.agent, question, urgent });
				}

				const reply = await this.awaitParentReply(run.id, task.id, PARENT_REPLY_TIMEOUT_MS);

				if (TERMINAL.includes(task.status)) {
					return "(your task was canceled while you waited — stop work and return immediately)";
				}
				this.updateTask(run, task, { status: "running" }, ctx);
				return reply;
			},
			onNotifyParent: (_taskId, message, level, final = false) =>
				this.delivery.submitLeaderReport(run, task, message, level, final, ctx),
			onSendMessage: (_taskId, to, text, final = false) => {
				if (to === "leader") return this.delivery.submitLeaderReport(run, task, text, "info", final, ctx);

				return this.mailboxes.send(`${run.id}:${task.id}`, `${run.id}:${to}`, text);
			},
			onPollMailbox: (taskId) => this.mailboxes.poll(`${run.id}:${taskId}`),
		};
	}
	private awaitParentReply(runId: string, taskId: string, timeoutMs = 0): Promise<string> {
		const key = `${runId}:${taskId}`;
		return new Promise<string>((resolve) => {
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
		pending.resolve(message);
		return true;
	}

	private onChildEvent(
		event: AgentSessionEvent,
		run: RunSnapshot,
		task: TaskSnapshot,
		ctx: ExtensionContext,
		onUpdate: ((partial: any) => void) | undefined,
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
			this.widget.schedule(run, ctx);
		} else if (event.type === "message_end") {
			const message = event.message as AssistantMessage;
			if (message?.role === "assistant") {
				updateUsageFromMessage(task, message);
				const text = getFirstText(message);
				if (text) {
					task.finalText = truncateText(text);
					task.finalTextFingerprint = textFingerprint(text);
					task.lastActivity = activitySnippet(text);
				}
				state.pendingFailure = classifyFailure(message.stopReason, message.errorMessage);
			}
			this.updateRun(run, ctx, onUpdate);
		} else if (event.type === "agent_end") {
			if (event.willRetry) {
				state.pendingFailure = undefined;
			} else {
				const failure = lastAssistantFailure(event.messages as AssistantMessage[]);
				if (failure) {
					state.pendingFailure = failure;
					state.failChildEnd?.(failureError(failure));
				}
			}
		} else if (event.type === "agent_settled") {
			state.childEndResolve?.();
		}
	}

	private async runChild(
		run: RunSnapshot,
		task: TaskSnapshot,
		input: TaskInput,
		routingTask: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onUpdate?: (partial: any) => void,
		resume?: ResumeInput,
	): Promise<void> {
		if (TERMINAL.includes(task.status)) return;

		const file = resolveAgentFile(input.agent, routingTask, task.cwd, getAgentDir());
		if (file?.path) task.agentFile = file.path;
		const prompt = file?.body ?? input.prompt?.trim();
		const thinking = input.thinking;

		const allowedTools = input.write ? WRITE_TOOLS : READONLY_TOOLS;
		const fileTools = file?.tools?.filter((t) => allowedTools.includes(t));
		const explicitTools = input.tools ?? (input.write ? WRITE_TOOLS : undefined);
		const baseTools = explicitTools ?? (fileTools?.length ? fileTools : allowedTools);
		if (explicitTools && fileTools?.length)
			task.toolsNote = `explicit tools overrode agent-file tools (${fileTools.join(", ")})`;
		const tools = [...baseTools, ...CHILD_TALK_TOOLS];

		const canWrite = baseTools.some((t) => WRITE_CAPABLE.includes(t));

		let model: Model<Api> | undefined;
		try {
			model = resolveChildModel(ctx, chooseModel(file, input.model).requested);
			validateThinking(model, thinking);

			const checked = await ensureUsableModel(ctx, model, signal, thinking);
			model = checked.model;
			if (checked.note) {
				task.modelNote = checked.note;
				validateThinking(model, thinking);
			}

			if (model) this.updateTask(run, task, { model: model.id, modelNote: checked.note }, ctx, onUpdate);
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

		let wt: Worktree | undefined;
		let isolationReason: string | undefined;
		if (canWrite && resume?.branch) {
			try {
				wt = attachWorktree(task.cwd, resume.branch);
				if (!wt) isolationReason = `branch ${resume.branch} no longer exists`;
			} catch (err) {
				isolationReason = `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`;
			}
		} else if (canWrite) {
			try {
				const upstream = (task.needs ?? [])
					.map((id) => run.tasks.find((t) => t.id === id))
					.filter((t) => t?.branch && t.status === "completed")
					.at(-1);
				wt = createWorktree(task.cwd, run.id, task.id, upstream?.branch);
				if (wt && upstream?.branch) task.stackedOn = upstream.branch;
				if (!wt) isolationReason = "not a git repository";
			} catch (err) {
				wt = undefined;
				isolationReason = `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`;
			}
		}

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

				try {
					mkdirSync(childCwd, { recursive: true });
				} catch {
					childCwd = wt.path;
				}
			}
		}
		if (canWrite) {
			task.isolation = wt ? "worktree" : "in-place";
			task.isolationReason = wt ? undefined : (isolationReason ?? "worktree unavailable");
		}
		if (wt) {
			claimWorktree(wt);
			this.liveWorktrees.set(`${run.id}:${task.id}`, wt);
		}

		try {
			this.updateTask(
				run,
				task,
				{
					status: "starting",
					startedAt: Date.now(),

					task: input.task,

					model: model?.id ?? input.model,
					provider: model?.provider,
					thinking,
					tools,
				},
				ctx,
				onUpdate,
			);
		} catch {}

		let keepWorktreeDir = false;
		let child: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let unsubscribe: (() => void) | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;
		const childState: ChildEventState = {};

		const key = `${run.id}:${task.id}`;
		try {
			const worktreeNote = wt
				? ` You work in an isolated git worktree (branch ${wt.branch})${task.stackedOn ? `, stacked on ${task.stackedOn} (its changes are already in your tree)` : ""}. Never run git commands that switch branches, create branches, or move the worktree (git switch/checkout/branch/worktree). The extension commits your changes when you finish. git status/diff are fine for inspecting your own changes. node_modules is a SHARED symlink to the main checkout: never install, upgrade, or delete dependencies (no npm/bun/yarn/pnpm install, no \`rm -rf node_modules\`) — those writes escape your worktree and damage the user's project. If the task truly needs a dependency change, edit the manifest only and say so in your answer.`
				: "";
			const subagentInstruction = `You are running as a subagent. Your bash tool already executes in the project working directory — never prefix commands with \`cd\`. Do not call subagent/delegation tools unless the parent explicitly asks. Return a concise final answer. You MAY use ask_parent only when truly blocked on information only the parent has (set urgent: true only when nothing else can proceed while you wait); notify_parent for one-way updates; send_agent_message/poll_agent_messages to coordinate with siblings. Your mailbox address and siblings: ${task.roster ?? "(none)"}. Use the exact task ids (e.g. task_2) as send_agent_message targets. Siblings run independently and may start late or finish early — never block indefinitely on their replies: poll at most 5 times, then proceed with your best judgment. A gated sibling (marked ↳ waits in the graph) may not be running yet; do not wait for it. An unanswered ask_parent times out after 10 minutes — proceed with your best judgment then. When your work is done, call notify_parent ONCE with final: true and your complete concise result — key findings, verdicts, file:line evidence — as your last tool call. Repeat that exact message as your final answer; changing it or doing more tool work keeps a completion follow-up. Progress updates omit final. Identical updates to the leader are deduplicated.${worktreeNote}`;

			const loader = new DefaultResourceLoader({
				cwd: childCwd,
				agentDir: getAgentDir(),
				noExtensions: true,
				extensionFactories: await codemodeFactories(),
				appendSystemPromptOverride: (base) => [
					...base,
					[prompt?.trim(), subagentInstruction].filter(Boolean).join("\n\n"),
				],
			});
			await loader.reload();

			const customTools: ToolDefinition[] = createChildTools(task.id, this.makeChildHandlers(run, task, ctx));

			const created = await createAgentSession({
				cwd: childCwd,
				agentDir: getAgentDir(),
				modelRuntime: await createChildModelRuntime(ctx),
				resourceLoader: loader,
				sessionManager: resume
					? SessionManager.open(resume.sessionFile, undefined, childCwd)
					: SessionManager.create(childCwd, undefined, { parentSession: getParentSessionFile(ctx) }),
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
				{
					status: "running",
					sessionId: child.sessionId,
					sessionFile: child.sessionFile,
					provider: child.model?.provider ?? task.provider,
					thinking: child.thinkingLevel,
				},
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
				this.onChildEvent(event, run, task, ctx, onUpdate, childState),
			);

			const abortChild = () => {
				void child?.abort();
				this.runControllers.get(run.id)?.abort();
			};
			const runController = this.runControllers.get(run.id);
			if (signal) signal.addEventListener("abort", abortChild, { once: true });
			if (runController) runController.signal.addEventListener("abort", abortChild, { once: true });
			abortListener = () => {
				signal?.removeEventListener("abort", abortChild);
				runController?.signal.removeEventListener("abort", abortChild);
			};

			if (run.status === "aborted" || TERMINAL.includes(task.status) || signal?.aborted) {
				await child.abort();
				throw new Error("Canceled by subagent_cancel");
			}
			this.liveChildren.set(key, {
				abort: () => void child?.abort(),
				dispose: () => child?.dispose(),

				steer: (message) =>
					void child?.prompt(message, { streamingBehavior: "steer" }).catch((err) =>
						this.pi.sendUserMessage(`[steer_subagent] ${err instanceof Error ? err.message : String(err)}`, {
							deliverAs: "followUp",
						}),
					),
			});

			const maxRuntimeMs = input.maxRuntimeMs ?? (this.autoLimit ? DEFAULT_RUNTIME_MS : UNLIMITED_RUNTIME_MS);
			// A resumed session can still be draining the turn that failed or timed out. Prompting while
			// its agent is mid-run is rejected outright ("already processing a prompt"), so wait first.
			if (resume) await child.waitForIdle();
			const promptPromise = child.prompt(resume?.message ?? task.task, { source: "extension" });
			const races: Promise<unknown>[] = [promptPromise, childFailurePromise, childEndPromise];
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
			// Prefer the fingerprint captured from the raw assistant text; never hash the 24-KiB-truncated copy.
			const finalFingerprint =
				task.finalTextFingerprint ??
				textFingerprint((child.messages as AssistantMessage[]).map(getFirstText).filter(Boolean).at(-1) || finalText);

			if (task.status === "awaiting_parent") {
				this.pendingReplies.get(key)?.resolve("(your task is being finalized — stop work and return now)");
			}
			if (!TERMINAL.includes(task.status)) {
				this.updateTask(
					run,
					task,
					{ status: "completed", finalText, finalTextFingerprint: finalFingerprint, endedAt: Date.now() },
					ctx,
					onUpdate,
				);
				if (wt) {
					let committed: "committed" | "empty" | undefined;
					try {
						committed = commitWorktree(wt, `subagent ${task.agent}: ${truncateText(input.task, 60)}`);

						keepWorktreeDir = committed === "committed";
					} catch (commitErr) {
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

			const aborted = signal?.aborted || run.status === "aborted" || task.status === "aborted";
			const subagentStatus = (err as Error & { subagentStatus?: string })?.subagentStatus;
			try {
				this.pendingReplies.get(key)?.resolve("(parent unreachable)");
				await Promise.race([child?.abort(), new Promise((r) => setTimeout(r, 5000))]);
			} catch {}

			const salvageText =
				(child?.messages as AssistantMessage[] | undefined)?.map(getFirstText).filter(Boolean).at(-1) || "";
			const salvaged = task.finalText || truncateText(salvageText);
			this.updateTask(
				run,
				task,
				{
					status: aborted ? "aborted" : ((subagentStatus as TaskStatus) ?? "failed"),
					error: err instanceof Error ? err.message : String(err),
					finalText: salvaged || undefined,
					finalTextFingerprint: task.finalTextFingerprint ?? (salvageText ? textFingerprint(salvageText) : undefined),
					endedAt: Date.now(),
				},
				ctx,
				onUpdate,
			);
		} finally {
			this.liveChildren.delete(key);

			this.pendingReplies.get(key)?.resolve("(task ended — stop work now)");
			this.pendingReplies.delete(key);
			abortListener?.();
			unsubscribe?.();
			if (timeout) clearTimeout(timeout);
			child?.dispose();

			if (wt && task.status !== "completed") {
				await new Promise((r) => setTimeout(r, 250));
				let partial: "committed" | "empty" | undefined;
				try {
					partial = commitWorktree(wt, `subagent ${task.agent} (partial, ${task.status})`);
				} catch {
					keepWorktreeDir = true;
				}

				if (partial === "committed" || keepWorktreeDir) {
					this.updateTask(run, task, { branch: wt.branch }, ctx, onUpdate);
				}
			}
			if (wt && !keepWorktreeDir) removeWorktree(wt);

			this.liveWorktrees.delete(key);
		}
	}

	createRun(params: SubagentParamsShape, ctx: ExtensionContext): { run: RunSnapshot; inputs: TaskInput[] } {
		const hasChain = (params.chain?.length ?? 0) > 0;
		const hasTasks = (params.tasks?.length ?? 0) > 0;

		const hasSingle = !hasChain && !hasTasks && Boolean(params.agent && params.task);
		if (hasChain && hasTasks) {
			throw new Error(`Provide either tasks (parallel) or chain (sequential), not both.`);
		}
		if (!hasChain && !hasTasks && !hasSingle) {
			throw new Error(
				`Provide one subagent mode: agent+task (single), tasks: [...] (parallel), or chain: [...] (sequential).`,
			);
		}

		if (hasChain || hasTasks) {
			const stray = (["write", "prompt", "tools", "model", "thinking"] as const).filter((k) => params[k] !== undefined);
			if (stray.length > 0) {
				throw new Error(
					`${stray.join(", ")} ${stray.length > 1 ? "describe" : "describes"} a single agent. Set ${stray.length > 1 ? "them" : "it"} on each item of ${hasChain ? "chain" : "tasks"} instead.`,
				);
			}
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
			: (hasTasks ? params.tasks! : params.chain!).map((item) => ({
					...item,
					cwd: item.cwd ?? params.cwd,
					maxRuntimeMs: item.maxRuntimeMs ?? params.maxRuntimeMs,
				}));
		if (inputs.length > MAX_TASKS) throw new Error(`Too many subagent tasks (${inputs.length}). Max is ${MAX_TASKS}.`);

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

		this.cleared = false;

		for (let i = 0; i < inputs.length; i++) {
			const input = inputs[i] as TaskInput;
			const cwd = input.cwd ?? ctx.cwd;
			const file = resolveAgentFile(input.agent, input.task, cwd, getAgentDir());
			const choice = chooseModel(file, input.model);
			try {
				validateThinking(resolveChildModel(ctx, choice.requested), input.thinking);
			} catch (err) {
				const where = choice.sourceFile
					? ` (from agent file ${choice.sourceFile}, which overrides the requested model${input.model ? ` "${input.model}"` : ""})`
					: "";
				throw new Error(
					`Task ${input.id ?? `task_${i + 1}`} (${input.agent}): ${err instanceof Error ? err.message : String(err)}${where}`,
				);
			}
		}

		const run: RunSnapshot = {
			id: newId("run"),
			mode,
			status: "queued",
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

		const outputs = new Map<string, string>();
		const settled = new Set<string>();
		for (const task of run.tasks) {
			if (TERMINAL.includes(task.status)) settled.add(task.id);
		}

		const inputById = new Map(run.tasks.map((t, i) => [t.id, inputs[i]]));

		const { skipped } = await runWaveScheduler(
			run.tasks.filter((t) => !TERMINAL.includes(t.status)),
			run.mode === "single" ? 1 : run.concurrency,
			outputs,
			settled,
			async (task) => {
				const input = inputById.get(task.id);
				if (!input) {
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
					input.task,
					ctx,
					signal,
					onUpdate,
				);
				if (task.status === "completed") outputs.set(task.id, task.finalText ?? "");
				if (run.notifyPerTask && TERMINAL.includes(task.status)) {
					this.delivery.notifyTask(run, task, task.status as "completed" | "failed" | "aborted");
				}
			},
		);

		for (const s of skipped) {
			const task = run.tasks.find((t) => t.id === s.id);
			if (task && !TERMINAL.includes(task.status)) {
				this.updateTask(
					run,
					task,
					{
						status: "aborted",

						error: task.error || `Skipped: upstream task(s) did not complete: ${s.needs.join(", ")}`,
						endedAt: Date.now(),
					},
					ctx,
					onUpdate,
				);
			}
		}

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
		this.widget.flush(run, ctx, onUpdate);

		const live = this.listRuns().find((r) => !TERMINAL.includes(r.status));
		if (live) this.widget.schedule(live, ctx);

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

		try {
			const roots = new Set<string>();
			for (const task of run.tasks) {
				if (!task.branch) continue;
				const root = repoRoot(task.cwd);
				if (root) roots.add(root);
			}
			for (const root of roots) cleanupMerged(root, { skipBranches: this.liveBranches() });
		} catch {}
	}

	ownsWorktree = (path: string): boolean => {
		for (const wt of this.liveWorktrees.values()) if (wt.path === path) return true;
		return false;
	};
	liveBranches(): Set<string> {
		return new Set(Array.from(this.liveWorktrees.values(), (wt) => wt.branch));
	}

	startInBackground(params: SubagentParamsShape, ctx: ExtensionContext): RunDetails {
		const { run, inputs } = this.createRun(params, ctx);
		void this.executeTasks(run, inputs, ctx, undefined, undefined)
			.then(() => {
				this.delivery.notifyParent(
					run,
					run.status === "completed" ? "completed" : run.status === "aborted" ? "aborted" : "failed",
				);
			})
			.catch((err) => {
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
				this.delivery.notifyParent(run, "failed");
				this.persist(ctx);
			});
		return { run: cloneRun(run) };
	}

	resumeTask(
		runId: string,
		taskId: string,
		ctx: ExtensionContext,
		opts: { message?: string; model?: string; thinking?: string } = {},
	): { ok: true; task: TaskSnapshot; note?: string } | { ok: false; reason: string } {
		const run = this.runs.get(runId);
		const task = run?.tasks.find((t) => t.id === taskId);
		if (!run || !task) return { ok: false, reason: `Unknown ${runId}/${taskId}.` };
		if (!TERMINAL.includes(task.status))
			return { ok: false, reason: `${taskId} is still ${task.status} — use steer_subagent.` };
		if (task.status === "completed") return { ok: false, reason: `${taskId} completed — spawn a new task instead.` };
		if (!task.sessionFile || !existsSync(task.sessionFile)) {
			return { ok: false, reason: `${taskId} has no session file to resume (never started) — respawn it.` };
		}
		if (this.liveChildren.has(`${runId}:${taskId}`)) return { ok: false, reason: `${taskId} is already live.` };
		// ponytail: resume only into a settled run — executeTasks' final sweep would abort a task revived mid-run. Upgrade: make the sweep skip tasks with a live child.
		if (!TERMINAL.includes(run.status)) {
			return { ok: false, reason: `Run ${runId} is still ${run.status} — wait for it to settle before resuming.` };
		}

		const tools = task.tools?.filter((t) => !(CHILD_TALK_TOOLS as readonly string[]).includes(t));
		const write = tools?.some((t) => WRITE_CAPABLE.includes(t)) ?? false;
		// A resume may swap the model, so the level stored on the task can be one the new model
		// rejects (a mode-clamped xhigh onto a model that only takes low|high|max). Clamp it against
		// the model runChild will actually use — including a matched agent file's, whose frontmatter
		// overrides the inline model at spawn — or the clamp would validate a different model.
		const file = resolveAgentFile(task.agent, task.task, task.cwd, getAgentDir());
		let resumeModel: Model<Api> | undefined;
		try {
			resumeModel = resolveChildModel(ctx, chooseModel(file, opts.model ?? task.model).requested);
		} catch {}
		const requestedThinking = (opts.thinking ?? task.thinking) as ThinkingLevel | undefined;
		const thinking = clampResumeThinking(resumeModel, requestedThinking);
		const thinkingNote =
			requestedThinking && thinking !== requestedThinking
				? `thinking ${requestedThinking} → ${thinking} (${resumeModel?.provider}/${resumeModel?.id} does not accept ${requestedThinking})`
				: undefined;
		const input: TaskInput = {
			id: task.id,
			agent: task.agent,
			task: task.task,
			cwd: task.cwd,
			write,
			tools: tools?.length ? tools : undefined,
			model: opts.model ?? task.model,
			thinking: thinking as TaskInput["thinking"],
			needs: task.needs,
		};
		const resume: ResumeInput = {
			sessionFile: task.sessionFile,
			branch: task.branch,
			message:
				opts.message?.trim() ||
				`Your previous turn ended with an error (${task.error ?? "unknown"}). Resume where you left off: briefly recap what you already did and what remains, then continue and finish the original task.`,
		};

		this.cleared = false;
		this.turnActivity = true;
		Object.assign(task, {
			status: "queued" as TaskStatus,
			thinking,
			error: undefined,
			endedAt: undefined,
			finalText: undefined,
			finalTextFingerprint: undefined,
			notifiedParent: false,
			finalParentReport: undefined,
			diffStat: undefined,
			changedFiles: undefined,
			worktreeError: undefined,
		});
		this.delivery.forgetTask(run, task);
		run.status = "running";
		run.endedAt = undefined;
		run.awaited = false;
		run.completionAwaited = false;
		this.settlers.set(run.id, true);
		this.runControllers.set(run.id, new AbortController());
		for (const t of run.tasks) this.mailboxes.open(`${run.id}:${t.id}`);
		this.updateRun(run, ctx);
		this.emit("subagent:task-resumed", { runId: run.id, taskId: task.id });

		void this.runChild(run, task, input, task.task, ctx, undefined, undefined, resume)
			.catch((err) => {
				if (!TERMINAL.includes(task.status)) {
					this.updateTask(
						run,
						task,
						{ status: "failed", error: err instanceof Error ? err.message : String(err), endedAt: Date.now() },
						ctx,
					);
				}
			})
			.then(() => {
				if (run.notifyPerTask) this.delivery.notifyTask(run, task, task.status as "completed" | "failed" | "aborted");
				this.finishRunIfSettled(run, ctx);
			});
		return { ok: true, task, note: thinkingNote };
	}

	private finishRunIfSettled(run: RunSnapshot, ctx: ExtensionContext): void {
		if (run.tasks.some((t) => !TERMINAL.includes(t.status))) return;
		const failed = run.tasks.some((t) => t.status === "failed");
		const aborted = run.tasks.some((t) => t.status === "aborted");
		run.status = aborted ? "aborted" : failed ? "failed" : "completed";
		run.endedAt = Date.now();
		this.widget.flush(run, ctx);
		this.emit("subagent:run-completed", {
			runId: run.id,
			status: run.status,
			run: cloneRun(run),
			aggregateUsage: run.aggregateUsage,
		});
		this.settleRun(run.id, run);
		this.runControllers.delete(run.id);
		for (const task of run.tasks) this.mailboxes.close(`${run.id}:${task.id}`);
		this.persist(ctx);
		this.delivery.notifyParent(
			run,
			run.status === "completed" ? "completed" : run.status === "aborted" ? "aborted" : "failed",
		);
	}

	steerTask(runId: string, taskId: string | undefined, message: string): boolean {
		const run = this.runs.get(runId);
		if (!run) return false;
		const ids = taskId ? [taskId] : run.tasks.map((t) => t.id).filter((id) => this.liveChildren.has(`${runId}:${id}`));
		if (ids.length === 0) return false;
		for (const id of ids) this.liveChildren.get(`${runId}:${id}`)?.steer(message);
		return true;
	}

	cancelTask(runId: string, taskId: string, ctx?: ExtensionContext): boolean {
		const run = this.runs.get(runId);
		const task = run?.tasks.find((t) => t.id === taskId);
		if (!run || !task || TERMINAL.includes(task.status)) return false;

		task.status = "aborted";
		task.error = task.error || "Canceled from peek";
		task.endedAt = Date.now();
		this.pendingReplies.get(`${runId}:${taskId}`)?.resolve("(task canceled by the parent — stop work now)");
		this.pendingReplies.delete(`${runId}:${taskId}`);
		this.liveChildren.get(`${runId}:${taskId}`)?.abort();
		this.mailboxes.close(`${runId}:${taskId}`);
		if (ctx) this.widget.flush(run, ctx);
		this.emit("subagent:task-aborted", { runId, taskId });
		return true;
	}

	cancelRun(runId: string): { aborted: number } {
		const run = this.runs.get(runId);
		if (!run) return { aborted: 0 };
		if (TERMINAL.includes(run.status)) return { aborted: 0 };
		let aborted = 0;
		this.runControllers.get(runId)?.abort();

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
			task.error = task.error || "Canceled by subagent_cancel";
			task.endedAt = Date.now();
			aborted += 1;

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

	private settleRun(runId: string, run: RunSnapshot): void {
		if (!this.settlers.has(runId)) return;
		this.settlers.delete(runId);
		const waiters = this.settleWaiters.get(runId);
		this.settleWaiters.delete(runId);
		if (!waiters?.size) return;
		if (this.parked.get(runId)?.size) {
			run.awaited = true;
			run.completionAwaited = true;
		}
		const snapshot = cloneRun(run);
		for (const waiter of waiters) waiter(snapshot);
	}

	private parked = new Map<string, Set<{ msgs: ParkedMsg[]; wake: () => void }>>();

	private collectParked(runId: string, msg: ParkedMsg): boolean {
		const parked = this.parked.get(runId);
		if (!parked || parked.size === 0) return false;
		let delivered = false;
		for (const p of parked) {
			if (p.msgs.length < PARKED_MSG_CAP) {
				p.msgs.push(msg);
				delivered = true;
			} else if (msg.kind === "ask") {
				const drop = p.msgs.findIndex((m) => m.kind !== "ask");
				if (drop !== -1) {
					p.msgs.splice(drop, 1);
					p.msgs.push(msg);
				} else {
					p.msgs[p.msgs.length - 1] = msg;
				}
				delivered = true;
			}
			p.wake();
		}

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
			parked.delete(entry);
			if (parked.size === 0) this.parked.delete(runId);
		};
		if (TERMINAL.includes(run.status)) {
			run.awaited = true;
			run.completionAwaited = true;
			return Promise.resolve({ run: cloneRun(run), intercom: [] });
		}
		const msgs: ParkedMsg[] = [];
		const settled = new Promise<RunSnapshot | undefined>((resolve) => {
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

					if (!timedOut) {
						run.awaited = true;
						if (r && TERMINAL.includes(r.status)) run.completionAwaited = true;
					}
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
			if (r && TERMINAL.includes(r.status)) run.completionAwaited = true;
			return { run: r, intercom: msgs };
		});
	}
}
