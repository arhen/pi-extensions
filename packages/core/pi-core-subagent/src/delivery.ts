import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeAskNotice, makeNotice, makeNoticeBatch, makeTaskArtifactNotice, makeTaskNotice } from "./format.ts";
import { artifactFingerprint, outcomeFingerprint, textFingerprint } from "./notification-state.ts";
import { type ParkedMsg, type RunSnapshot, type TaskSnapshot, TERMINAL } from "./types.ts";

/** A notice Pi accepted but that is missing from the canonical context this long after, while idle, is lost. */
const RECEIPT_GRACE_MS = 3_000;
/**
 * A notice Pi never accepted (its prompt threw before the input stage, e.g. during compaction) is lost
 * once the leader has been idle this long. Pi runs prompts submitted during settlement one after
 * another, so an unaccepted notice is only proven gone after the leader stays idle past that queue.
 */
const UNACCEPTED_IDLE_MS = 30_000;
/** Minimum wait before retrying a failed submission, so one flush cannot burn every attempt. */
const RETRY_BACKOFF_MS = 1_000;
/** Total submission attempts before a notice is declared lost. */
const MAX_DELIVERY_ATTEMPTS = 3;

interface LeaderMessageReceipt {
	runId: string;
	taskIds: string[];
	kind: "update" | "final" | "terminal";
	deliverAs: "steer" | "followUp";
	delivered: boolean;
	submitted: boolean;
	lost: boolean;
	submittedAt: number;
	attempts: number;
	/** When Pi's prompt pipeline (the `input` event) saw this body; unset while it waits in Pi's queue. */
	acceptedAt?: number;
}

interface OutboxEntry {
	runId: string;
	taskIds: string[];
	kind: "update" | "final" | "terminal";
	deliverAs: "steer" | "followUp";
	attempts?: number;
	attemptedAt?: number;
}

interface TerminalNotice {
	body: string;
	fingerprint: string;
	delivery: "pending" | "received" | "lost";
}

/** What delivery needs from the manager that owns runs, live children, parking and persistence. */
export interface DeliveryHost {
	readonly pi: ExtensionAPI;
	isCleared(): boolean;
	findRun(runId: string): RunSnapshot | undefined;
	/** `runId:taskId` of a child session that is still running. */
	isLive(key: string): boolean;
	persist(ctx: ExtensionContext): void;
	emit(type: string, payload: Record<string, unknown>): void;
	collectParked(runId: string, msg: ParkedMsg): boolean;
}

/**
 * Leader-facing notifications: per-task and aggregate notices, held follow-ups (outbox), submitted
 * receipts confirmed against the canonical leader context, loss detection with bounded retries, and
 * de-duplication against final parent reports and terminal awaits.
 */
export class LeaderDelivery {
	private leaderMessages = new Map<string, LeaderMessageReceipt>();
	private outbox = new Map<string, OutboxEntry>();
	private parkedBodies = new Map<string, Set<string>>();
	private lastLeaderActivityAt = Date.now();
	private terminalNotices = new Map<string, TerminalNotice>();
	private awaitedTaskNotices = new Map<string, string>();
	private pendingTaskNotices = new Map<string, { run: RunSnapshot; task: TaskSnapshot }>();
	private pendingRunNotices = new Map<string, RunSnapshot>();
	private notificationRetries = new Set<string>();
	private notificationFlushTimer: ReturnType<typeof setTimeout> | undefined;
	notificationContext: ExtensionContext | undefined;

	constructor(private readonly host: DeliveryHost) {}

	/** Session end: forget every notice, receipt and pending flush. */
	reset(): void {
		this.leaderMessages.clear();
		this.outbox.clear();
		this.parkedBodies.clear();
		this.terminalNotices.clear();
		this.awaitedTaskNotices.clear();
		this.pendingTaskNotices.clear();
		this.pendingRunNotices.clear();
		this.notificationRetries.clear();
		if (this.notificationFlushTimer) clearTimeout(this.notificationFlushTimer);
		this.notificationFlushTimer = undefined;
		this.notificationContext = undefined;
	}

	/** A resumed task starts a fresh outcome: drop its notices so the next settle reports it again. */
	forgetTask(run: RunSnapshot, task: TaskSnapshot): void {
		const scope = `${run.id}:${task.id}`;
		this.terminalNotices.delete(scope);
		this.pendingTaskNotices.delete(scope);
		this.pendingRunNotices.delete(run.id);
		this.notificationRetries.delete(run.id);
		for (const [body, receipt] of this.leaderMessages) {
			if (receipt.runId !== run.id || !receipt.taskIds.includes(task.id)) continue;
			if (receipt.taskIds.length === 1) {
				this.leaderMessages.delete(body);
				continue;
			}
			// A shared aggregate stays for its remaining tasks; the resumed task's slice is published
			// again by the run's next settle.
			receipt.taskIds = receipt.taskIds.filter((id) => id !== task.id);
		}
		for (const [body, entry] of this.outbox) {
			if (entry.runId !== run.id || !entry.taskIds.includes(task.id)) continue;
			if (entry.taskIds.length === 1) {
				this.outbox.delete(body);
				continue;
			}
			this.outbox.delete(body);
			for (const otherId of entry.taskIds) {
				if (otherId === task.id) continue;
				const notice = this.terminalNotices.get(`${run.id}:${otherId}`);
				if (notice) notice.delivery = "lost";
			}
		}
		this.awaitedTaskNotices.delete(scope);
	}

	private finalReportMatches(task: TaskSnapshot): boolean {
		const report = task.finalParentReport;
		if (!report || report.toolCalls !== task.toolCalls) return false;
		const fingerprint = task.finalTextFingerprint ?? textFingerprint(task.finalText ?? "");
		return report.fingerprint === fingerprint;
	}

	private hasArtifactDelta(task: TaskSnapshot): boolean {
		return artifactFingerprint(task) !== task.finalParentReport?.artifacts;
	}

	private leaderMessageText(content: unknown): string {
		return typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter((part) => part?.type === "text")
						.map((part) => part.text ?? "")
						.join("\n")
				: "";
	}

	/**
	 * One pass over the finalized leader projection. Returns undefined when the pinned pi build
	 * cannot project (never treat that as loss, or every receipt would be replayed).
	 */
	private projectionBody(ctx: ExtensionContext): string | undefined {
		try {
			const manager = ctx.sessionManager as unknown as {
				buildSessionProjection?: () => { messages: readonly { role?: string; content?: unknown }[] };
			};
			if (typeof manager.buildSessionProjection !== "function") return undefined;
			const messages = manager.buildSessionProjection().messages;
			const parts: string[] = [];
			for (const message of messages) {
				if (message.role !== "user" && message.role !== "custom") continue;
				parts.push(this.leaderMessageText(message.content));
			}
			return parts.join("\n");
		} catch {
			return undefined;
		}
	}

	/** Leader run lifecycle (start/end/settle): an unaccepted notice is only lost after a long idle stretch. */
	noteLeaderActivity(): void {
		this.lastLeaderActivityAt = Date.now();
	}

	/**
	 * Pi's `input` stage saw a prompt. A submitted notice whose body it carries has left Pi's queue: from
	 * here a missing transcript entry means it was dropped or rewritten, not that it is still waiting.
	 */
	noteLeaderInput(text: string, source: string): void {
		if (source !== "extension") return;
		const now = Date.now();
		for (const [body, receipt] of this.leaderMessages) {
			if (receipt.acceptedAt === undefined && !receipt.delivered && !receipt.lost && text.includes(body))
				receipt.acceptedAt = now;
		}
	}

	private recordSubmission(body: string, entry: OutboxEntry, attempts: number): void {
		this.leaderMessages.set(body, {
			runId: entry.runId,
			taskIds: entry.taskIds,
			kind: entry.kind,
			deliverAs: entry.deliverAs,
			delivered: false,
			submitted: true,
			lost: false,
			submittedAt: Date.now(),
			attempts,
		});
	}

	/** True when a terminal await already rendered this task's outcome. */
	private coveredByAwait(runId: string, taskId: string, fingerprint: string): boolean {
		return this.awaitedTaskNotices.get(`${runId}:${taskId}`) === fingerprint;
	}

	/** Record what a terminal await actually rendered, so held notices are dropped instead of echoed. */
	markAwaitCoverage(run: RunSnapshot, coveredTaskIds?: ReadonlySet<string>): void {
		for (const task of run.tasks) {
			if (!TERMINAL.includes(task.status)) continue;
			if (coveredTaskIds && !coveredTaskIds.has(task.id)) continue;
			const scope = `${run.id}:${task.id}`;
			this.awaitedTaskNotices.set(scope, outcomeFingerprint(task));
			this.pendingTaskNotices.delete(scope);
		}
		for (const [body, entry] of [...this.outbox]) {
			if (entry.runId !== run.id) continue;
			if (!this.outboxCovered(entry)) continue;
			const task = run.tasks.find((t) => t.id === entry.taskIds[0]);
			// An update is not part of the rendered summary; only terminal/aggregate entries are safe to drop.
			if (entry.kind === "update") continue;
			if (entry.kind === "final" && (!task || !this.finalReportMatches(task))) continue;
			this.dropOutbox(body, entry, "awaited");
		}
	}

	private outboxCovered(entry: OutboxEntry): boolean {
		const run = this.host.findRun(entry.runId);
		if (!run) return false;
		return entry.taskIds.every((taskId) => {
			const task = run.tasks.find((t) => t.id === taskId);
			if (!task || !TERMINAL.includes(task.status)) return false;
			return this.coveredByAwait(entry.runId, taskId, outcomeFingerprint(task));
		});
	}

	private dropOutbox(body: string, entry: OutboxEntry, delivery: string): void {
		this.outbox.delete(body);
		const task = this.host.findRun(entry.runId)?.tasks.find((t) => t.id === entry.taskIds[0]);
		if (entry.kind === "final" && task?.finalParentReport?.body === body) task.finalParentReport.delivery = "awaited";
		if (entry.kind === "terminal") {
			for (const taskId of entry.taskIds) {
				const notice = this.terminalNotices.get(`${entry.runId}:${taskId}`);
				if (notice?.body === body) notice.delivery = "received";
			}
		}
		this.host.emit("subagent:notification", {
			runId: entry.runId,
			taskId: entry.taskIds[0],
			kind: "completed",
			body: "",
			suppressed: true,
			delivery,
		});
	}

	private enqueueNotification(body: string, entry: OutboxEntry, ctx?: ExtensionContext): void {
		this.outbox.set(body, entry);
		const flushContext = ctx ?? this.notificationContext;
		if (flushContext) this.scheduleNotificationFlush(flushContext);
	}

	private noteTerminal(runId: string, taskId: string, body: string, fingerprint: string): void {
		this.terminalNotices.set(`${runId}:${taskId}`, { body, fingerprint, delivery: "pending" });
	}

	submitLeaderReport(
		run: RunSnapshot,
		task: TaskSnapshot,
		message: string,
		level: "info" | "warning" | "error",
		final: boolean,
		ctx: ExtensionContext,
	): boolean {
		if (this.host.isCleared()) return false;
		this.notificationContext = ctx;
		const body = `[Subagent ${task.agent} (${task.id}, ${run.id})]${final ? " Final result:" : ""}${level === "info" ? "" : ` [${level}]`} ${message}`;
		const previous = this.leaderMessages.get(body);
		if ((previous && !previous.lost) || this.outbox.has(body)) {
			if (final) {
				task.finalParentReport = {
					body,
					message,
					toolCalls: task.toolCalls,
					fingerprint: textFingerprint(message),
					artifacts: artifactFingerprint(task),
					delivery: previous?.delivered ? "message" : "pending",
				};
			}
			return true;
		}
		if (previous?.lost) this.leaderMessages.delete(body);
		const report: TaskSnapshot["finalParentReport"] = final
			? {
					body,
					message,
					toolCalls: task.toolCalls,
					fingerprint: textFingerprint(message),
					artifacts: artifactFingerprint(task),
					delivery: "pending",
				}
			: undefined;
		if (report) task.finalParentReport = report;
		this.host.emit("subagent:intercom", { runId: run.id, taskId: task.id, kind: "notify", level, message, final });
		if (this.host.collectParked(run.id, { kind: "notify", taskId: task.id, agent: task.agent, text: message, final })) {
			let parked = this.parkedBodies.get(run.id);
			if (!parked) {
				parked = new Set();
				this.parkedBodies.set(run.id, parked);
			}
			if (parked.has(body)) return true;
			parked.add(body);
			task.notifiedParent = true;
			if (report) report.delivery = "parked";
			return true;
		}
		this.enqueueNotification(body, {
			runId: run.id,
			taskIds: [task.id],
			kind: final ? "final" : "update",
			deliverAs: "followUp",
		});
		return true;
	}

	private hasPendingSuccessMessages(run: RunSnapshot): boolean {
		return run.tasks.some((task) => {
			const notice = this.terminalNotices.get(`${run.id}:${task.id}`);
			if (notice?.delivery !== "pending") return false;
			const receipt = this.leaderMessages.get(notice.body);
			return receipt ? !receipt.delivered && !receipt.lost : this.outbox.has(notice.body);
		});
	}

	confirmLeaderMessages(ctx: ExtensionContext): void {
		if (this.host.isCleared()) return;
		const projection = this.projectionBody(ctx);
		let changed = false;
		for (const [body, receipt] of [...this.leaderMessages]) {
			if (receipt.delivered || receipt.lost || projection === undefined || !projection.includes(body)) continue;
			receipt.delivered = true;
			changed = true;
			const run = this.host.findRun(receipt.runId);
			for (const taskId of receipt.taskIds) {
				const task = run?.tasks.find((t) => t.id === taskId);
				if (!task) continue;
				task.notifiedParent = true;
				if (task.finalParentReport?.body === body) task.finalParentReport.delivery = "message";
				const key = `${receipt.runId}:${taskId}`;
				const notice = this.terminalNotices.get(key);
				if (notice?.body === body) notice.delivery = "received";
				const pending = this.pendingTaskNotices.get(key);
				if (pending && this.finalReportMatches(task)) {
					this.pendingTaskNotices.delete(key);
					if (this.hasArtifactDelta(task)) this.notifyTask(pending.run, task, "completed");
				}
			}
			if (run && !this.hasPendingSuccessMessages(run)) this.pendingRunNotices.delete(run.id);
		}
		if (changed) this.host.persist(ctx);
		for (const [body, receipt] of this.leaderMessages) {
			if (!receipt.delivered && !receipt.lost) continue;
			const run = this.host.findRun(receipt.runId);
			const tasks = run?.tasks.filter((task) => receipt.taskIds.includes(task.id)) ?? [];
			if (
				tasks.length > 0 &&
				tasks.every((task) => TERMINAL.includes(task.status) && !this.host.isLive(`${receipt.runId}:${task.id}`))
			)
				this.leaderMessages.delete(body);
		}
	}

	/**
	 * Called only while the leader is idle. A notice Pi accepted (its `input` stage saw the body) has had
	 * its turn: missing from the canonical context after the grace period, it was dropped or rewritten.
	 * A notice Pi never accepted may still wait in Pi's settle queue — prompts submitted during
	 * `agent_settled` run one after another, and the leader looks idle between them — so another run
	 * starting proves nothing; only a long idle stretch does.
	 */
	private markLostReceipts(ctx: ExtensionContext, existing: ReadonlySet<string>): void {
		const now = Date.now();
		const projection = this.projectionBody(ctx);
		if (projection === undefined) return;
		for (const [body, receipt] of [...this.leaderMessages]) {
			if (receipt.delivered || receipt.lost || !existing.has(body)) continue;
			if (this.outbox.has(body)) continue;
			const gone =
				receipt.acceptedAt !== undefined
					? now - receipt.acceptedAt >= RECEIPT_GRACE_MS
					: now - receipt.submittedAt >= UNACCEPTED_IDLE_MS && now - this.lastLeaderActivityAt >= UNACCEPTED_IDLE_MS;
			if (!gone) continue;
			if (projection.includes(body)) continue;
			if (receipt.attempts < MAX_DELIVERY_ATTEMPTS) {
				this.leaderMessages.delete(body);
				this.outbox.set(body, {
					runId: receipt.runId,
					taskIds: receipt.taskIds,
					kind: receipt.kind,
					deliverAs: receipt.deliverAs,
					attempts: receipt.attempts,
					attemptedAt: now,
				});
				continue;
			}
			receipt.lost = true;
			for (const taskId of receipt.taskIds) {
				const key = `${receipt.runId}:${taskId}`;
				const notice = this.terminalNotices.get(key);
				if (notice?.body === body) notice.delivery = "lost";
				const task = this.host.findRun(receipt.runId)?.tasks.find((t) => t.id === taskId);
				if (task?.finalParentReport?.body === body) task.finalParentReport.delivery = "lost";
			}
			this.host.emit("subagent:notification", {
				runId: receipt.runId,
				taskId: receipt.taskIds[0],
				kind: "completed",
				body,
				delivery: "lost",
			});
			// A lost final report must still reach the leader: per-task hold or a direct full fallback.
			if (receipt.kind === "final") {
				const run = this.host.findRun(receipt.runId);
				for (const taskId of receipt.taskIds) {
					if (this.pendingTaskNotices.has(`${receipt.runId}:${taskId}`)) continue;
					const task = run?.tasks.find((t) => t.id === taskId);
					if (run && task) this.notifyTask(run, task, "completed");
				}
			}
		}
	}

	/**
	 * Submit every releasable held notice as ONE leader message. Each notice is its own leader turn
	 * otherwise — a full model call over the whole context — and Pi would queue them one behind the
	 * other. Bodies stay verbatim inside the batch, so each receipt still confirms on its own.
	 */
	private flushOutbox(): void {
		const now = Date.now();
		const batch: [string, OutboxEntry][] = [];
		for (const [body, entry] of [...this.outbox]) {
			if (this.outboxCovered(entry)) {
				this.dropOutbox(body, entry, "awaited");
				continue;
			}
			if (entry.attemptedAt && now - entry.attemptedAt < RETRY_BACKOFF_MS) continue;
			batch.push([body, entry]);
		}
		if (batch.length === 0) return;
		const deliverAs = batch.some(([, entry]) => entry.deliverAs === "steer") ? "steer" : "followUp";
		// Receipts exist before the send: Pi runs the input stage synchronously when the leader is idle.
		for (const [body, entry] of batch) {
			this.outbox.delete(body);
			this.recordSubmission(body, entry, (entry.attempts ?? 0) + 1);
		}
		try {
			this.host.pi.sendUserMessage(makeNoticeBatch(batch.map(([body]) => body)), { deliverAs });
		} catch {
			for (const [body, entry] of batch) {
				this.leaderMessages.delete(body);
				const attempts = (entry.attempts ?? 0) + 1;
				if (attempts < MAX_DELIVERY_ATTEMPTS) {
					this.outbox.set(body, { ...entry, attempts, attemptedAt: now });
					continue;
				}
				this.host.emit("subagent:notification", {
					runId: entry.runId,
					taskId: entry.taskIds[0],
					kind: "completed",
					body,
					delivery: "failed",
				});
			}
			return;
		}
		for (const [body, entry] of batch) {
			if (entry.kind === "terminal") {
				for (const taskId of entry.taskIds) {
					const notice = this.terminalNotices.get(`${entry.runId}:${taskId}`);
					if (notice?.body === body) notice.delivery = "pending";
				}
			}
			this.host.emit("subagent:notification", {
				runId: entry.runId,
				taskId: entry.taskIds[0],
				kind: "completed",
				body,
				delivery: "submitted",
			});
		}
	}

	flushPendingNotifications(ctx: ExtensionContext): void {
		const existing = new Set([...this.leaderMessages.keys(), ...this.outbox.keys()]);
		this.confirmLeaderMessages(ctx);
		if (this.host.isCleared()) return;
		let idle = false;
		try {
			idle = ctx.isIdle() && !ctx.hasPendingMessages();
		} catch {
			idle = false;
		}
		if (idle) this.markLostReceipts(ctx, existing);
		const outstandingReceipts = () =>
			[...this.leaderMessages.values()].some((receipt) => !receipt.delivered && !receipt.lost);
		if (!this.pendingTaskNotices.size && !this.pendingRunNotices.size && !this.outbox.size && !outstandingReceipts())
			return;
		if (idle) {
			// Resolve held task/run notices first so everything releasable leaves in the single flush below.
			for (const [key, pending] of [...this.pendingTaskNotices]) {
				const report = pending.task.finalParentReport;
				if (report?.delivery === "lost") {
					this.pendingTaskNotices.delete(key);
					pending.task.finalParentReport = undefined;
					this.notifyTask(pending.run, pending.task, "completed");
					continue;
				}
				if (report?.delivery === "pending") {
					const outstanding = this.leaderMessages.has(report.body) || this.outbox.has(report.body);
					if (outstanding) continue;
					this.pendingTaskNotices.delete(key);
					pending.task.finalParentReport = undefined;
					this.notifyTask(pending.run, pending.task, "completed");
					continue;
				}
				this.pendingTaskNotices.delete(key);
				if (report && this.finalReportMatches(pending.task) && this.hasArtifactDelta(pending.task))
					this.notifyTask(pending.run, pending.task, "completed");
			}
			for (const [key, run] of [...this.pendingRunNotices]) {
				const notices = run.tasks
					.map((task) => this.terminalNotices.get(`${run.id}:${task.id}`))
					.filter((notice): notice is TerminalNotice => Boolean(notice));
				const waiting = notices.some((notice) => {
					const receipt = this.leaderMessages.get(notice.body);
					return notice.delivery === "pending" && (!receipt || (!receipt.delivered && !receipt.lost));
				});
				if (waiting) continue;
				this.pendingRunNotices.delete(key);
				const lost = notices.some((notice) => notice.delivery === "lost");
				if (!lost || this.notificationRetries.has(run.id)) continue;
				this.notificationRetries.add(run.id);
				this.notifyParent(run, run.status === "aborted" ? "aborted" : run.status === "failed" ? "failed" : "completed");
			}
			this.flushOutbox();
		}
		// Anything still unresolved (including a retry backoff) must be revisited without unrelated activity.
		this.scheduleNotificationFlush(ctx, RETRY_BACKOFF_MS);
	}

	scheduleNotificationFlush(ctx: ExtensionContext, delayMs = 100): void {
		if (
			this.notificationFlushTimer ||
			this.host.isCleared() ||
			(!this.pendingTaskNotices.size &&
				!this.pendingRunNotices.size &&
				!this.outbox.size &&
				![...this.leaderMessages.values()].some((receipt) => !receipt.delivered && !receipt.lost))
		)
			return;
		this.notificationFlushTimer = setTimeout(() => {
			this.notificationFlushTimer = undefined;
			this.flushPendingNotifications(ctx);
		}, delayMs);
		this.notificationFlushTimer.unref?.();
	}

	notifyTask(run: RunSnapshot, task: TaskSnapshot, kind: "completed" | "failed" | "aborted"): void {
		const key = `${run.id}:${task.id}`;
		const outcome = outcomeFingerprint(task);
		const final = kind === "completed" && this.finalReportMatches(task);
		const report = task.finalParentReport;
		if (final && report?.delivery === "pending") {
			this.pendingTaskNotices.set(key, { run, task });
			if (this.notificationContext) this.scheduleNotificationFlush(this.notificationContext);
			this.host.emit("subagent:notification", {
				runId: run.id,
				taskId: task.id,
				kind,
				body: "",
				suppressed: true,
				delivery: "pending",
			});
			return;
		}
		if (
			final &&
			report &&
			report.delivery !== "lost" &&
			report.delivery !== "pending" &&
			!this.hasArtifactDelta(task)
		) {
			this.host.emit("subagent:notification", {
				runId: run.id,
				taskId: task.id,
				kind,
				body: "",
				suppressed: true,
				delivery: report.delivery,
			});
			return;
		}
		const covered = this.terminalNotices.get(key);
		if (covered?.fingerprint === outcome && covered.delivery !== "lost") {
			this.host.emit("subagent:notification", {
				runId: run.id,
				taskId: task.id,
				kind,
				body: "",
				suppressed: true,
				delivery: covered.delivery,
			});
			return;
		}
		if (this.coveredByAwait(run.id, task.id, outcome)) {
			this.host.emit("subagent:notification", {
				runId: run.id,
				taskId: task.id,
				kind,
				body: "",
				suppressed: true,
				delivery: "awaited",
			});
			return;
		}
		const artifactOnly = final && report?.delivery !== "lost";
		const body = artifactOnly ? makeTaskArtifactNotice(run, task) : makeTaskNotice(run, task, kind);
		if (this.host.collectParked(run.id, { kind: "done", taskId: task.id, agent: task.agent, text: body })) {
			this.noteTerminal(run.id, task.id, body, outcome);
			this.terminalNotices.get(key)!.delivery = "received";
			this.host.emit("subagent:notification", { runId: run.id, taskId: task.id, kind, body, delivery: "parked" });
			return;
		}
		if (kind === "failed") {
			this.noteTerminal(run.id, task.id, body, outcome);
			this.recordSubmission(body, { runId: run.id, taskIds: [task.id], kind: "terminal", deliverAs: "steer" }, 0);
			try {
				this.host.pi.sendUserMessage(body, { deliverAs: "steer" });
				this.host.emit("subagent:notification", { runId: run.id, taskId: task.id, kind, body, delivery: "submitted" });
				if (this.notificationContext) this.scheduleNotificationFlush(this.notificationContext, RECEIPT_GRACE_MS);
			} catch {
				this.leaderMessages.delete(body);
				this.terminalNotices.get(key)!.delivery = "lost";
				this.host.emit("subagent:notification", { runId: run.id, taskId: task.id, kind, body, delivery: "failed" });
			}
			return;
		}
		this.noteTerminal(run.id, task.id, body, outcome);
		this.enqueueNotification(body, {
			runId: run.id,
			taskIds: [task.id],
			kind: "terminal",
			deliverAs: "followUp",
		});
		this.host.emit("subagent:notification", { runId: run.id, taskId: task.id, kind, body, delivery: "held" });
	}

	notifyParent(
		run: RunSnapshot,
		kind: "completed" | "failed" | "aborted" | "asked",
		extra?: { taskId?: string; agent?: string; question?: string; urgent?: boolean },
	): void {
		if (kind !== "asked" && run.completionAwaited) return;
		let tasks = run.tasks;
		if (kind !== "asked") {
			tasks = tasks.filter((task) => {
				const key = `${run.id}:${task.id}`;
				const outcome = outcomeFingerprint(task);
				const covered = this.terminalNotices.get(key);
				if (covered?.fingerprint === outcome && covered.delivery !== "lost") return false;
				if (this.pendingTaskNotices.has(key)) return false;
				if (this.coveredByAwait(run.id, task.id, outcome)) return false;
				if (
					kind === "completed" &&
					task.finalParentReport?.delivery !== "lost" &&
					this.finalReportMatches(task) &&
					!this.hasArtifactDelta(task)
				)
					return false;
				return true;
			});
			if (tasks.length === 0) {
				if (!this.notificationRetries.has(run.id) && this.hasPendingSuccessMessages(run)) {
					this.pendingRunNotices.set(run.id, run);
					if (this.notificationContext) this.scheduleNotificationFlush(this.notificationContext);
				}
				this.host.emit("subagent:notification", { runId: run.id, kind, body: "", suppressed: true });
				return;
			}
			// Aggregate-only mode has no per-task hold: keep a run-level watch so a pending report
			// that later goes lost still produces a fallback.
			if (
				!this.notificationRetries.has(run.id) &&
				!this.pendingRunNotices.has(run.id) &&
				run.tasks.some((task) => task.finalParentReport?.delivery === "pending")
			) {
				this.pendingRunNotices.set(run.id, run);
				if (this.notificationContext) this.scheduleNotificationFlush(this.notificationContext);
			}
		}
		if (kind === "asked") {
			const body = makeAskNotice(run, extra ?? {});
			try {
				this.host.pi.sendUserMessage(body, { deliverAs: "steer" });
				this.host.emit("subagent:notification", {
					runId: run.id,
					taskId: extra?.taskId,
					kind,
					body,
					delivery: "submitted",
				});
			} catch {
				this.host.emit("subagent:notification", {
					runId: run.id,
					taskId: extra?.taskId,
					kind,
					body,
					delivery: "failed",
				});
			}
			return;
		}
		const body = makeNotice(run, kind, tasks);
		const deliverAs = kind === "failed" ? "steer" : "followUp";
		for (const task of tasks) this.noteTerminal(run.id, task.id, body, outcomeFingerprint(task));
		if (deliverAs === "steer") {
			this.recordSubmission(body, { runId: run.id, taskIds: tasks.map((t) => t.id), kind: "terminal", deliverAs }, 0);
			try {
				this.host.pi.sendUserMessage(body, { deliverAs });
				if (this.notificationContext) this.scheduleNotificationFlush(this.notificationContext, RECEIPT_GRACE_MS);
			} catch {
				this.leaderMessages.delete(body);
				for (const task of tasks) {
					const notice = this.terminalNotices.get(`${run.id}:${task.id}`);
					if (notice?.body === body) notice.delivery = "lost";
				}
			}
			this.host.emit("subagent:notification", { runId: run.id, kind, body, delivery: "submitted" });
			this.holdRunFallback(run, tasks);
			return;
		}
		this.enqueueNotification(body, {
			runId: run.id,
			taskIds: tasks.map((t) => t.id),
			kind: "terminal",
			deliverAs,
		});
		this.host.emit("subagent:notification", { runId: run.id, kind, body, delivery: "held" });
		this.holdRunFallback(run, tasks);
	}

	/** Keep one bounded retry for aggregates whose per-task receipts never arrived. */
	private holdRunFallback(run: RunSnapshot, tasks: TaskSnapshot[]): void {
		if (this.notificationRetries.has(run.id)) return;
		const covered = tasks.filter((task) => {
			const notice = this.terminalNotices.get(`${run.id}:${task.id}`);
			return Boolean(notice && notice.body !== "");
		});
		if (covered.length === 0) return;
		this.pendingRunNotices.set(run.id, run);
		if (this.notificationContext) this.scheduleNotificationFlush(this.notificationContext);
	}
}
