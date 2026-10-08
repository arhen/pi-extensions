import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { BenchMode, BenchOptions, CodemodeState } from "./args.ts";
import { controlledArguments, matchesControlledArguments } from "./contract.ts";
import {
	addUsage,
	type BenchRunSnapshot,
	type BusNotification,
	type ChildSessionMetrics,
	captureBusNotifications,
	collectRuns,
	emptyUsage,
	findChildSession,
	type MessageRecord,
	Probe,
	parseChildSessionFile,
	type ToolRecord,
	type UsageCounts,
} from "./probe.ts";
import type { RepeatSummary } from "./repeat-summary.ts";
import { usageBreakdown } from "./report.ts";
import {
	applyPresentationCommands,
	errorMessage,
	type RunContext,
	skeletonTarget,
	sleep,
	waitForBusCompletion,
	waitForSettle,
} from "./samples.ts";
import {
	type BuildTimings,
	type BuiltSession,
	buildParentSession,
	type DuplicateTool,
	type ExtensionDescription,
	type ModelIdentity,
	type SettingsDiagnostics,
	type TargetInfo,
} from "./session.ts";

export const REPEAT_SCHEMA = "pi-core-subagent-repeat-bench/v1";
export const REPEAT_HARNESS_VERSION = "1.0.0";
export const DEFAULT_QUIESCE_MS = 500;

export function fullInputOf(usage: UsageCounts): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** Parent prompt for one repeated delegation: numbered turn, identical controlled child arguments. */
export function repeatPrompt(opts: BenchOptions, iteration: number): string {
	return `Start a NEW independent run for delegation ${iteration}; do not reuse the previous result.\n${opts.delegatePrompt}`;
}

/** Live runs require the exact controlled child arguments to be embedded in the fixed delegate prompt. */
export function promptEmbedsControlledArguments(opts: BenchOptions): boolean {
	return opts.delegatePrompt.includes(JSON.stringify(controlledArguments(opts)));
}

export function dedupeNotifications(events: BusNotification[]): BusNotification[] {
	const seen = new Set<string>();
	const out: BusNotification[] = [];
	for (const event of events) {
		const key = `${event.kind ?? ""}|${event.runId ?? ""}|${event.taskId ?? ""}|${event.body ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(event);
	}
	return out;
}

const TERMINAL_KINDS = new Set(["completed", "failed", "aborted", "done"]);

function terminalNotificationIn(
	events: BusNotification[],
	runId: string,
	afterMs: number,
): BusNotification | undefined {
	return events.find(
		(event) =>
			event.atMs >= afterMs && event.kind !== undefined && TERMINAL_KINDS.has(event.kind) && event.runId === runId,
	);
}

export interface RepeatChildReport {
	runId: string | undefined;
	status: string | undefined;
	model: string | undefined;
	provider: string | undefined;
	thinking: string | undefined;
	sessionFile: string | undefined;
	branch: string | undefined;
	usage: UsageCounts | undefined;
	usageSource: "run-snapshot" | "session-file" | "none";
	costEstimate: number | undefined;
	toolCalls: number | undefined;
	modelCalls: number | undefined;
	finalText: string | undefined;
	containsBenchOk: boolean | undefined;
}

export interface RepeatIterationReport {
	iteration: number;
	valid: boolean;
	invalidReason?: string;
	prompt: string;
	/** Probe-relative time of prompt dispatch: the per-iteration timing origin. */
	promptAtMs: number;
	promptReturnMs: number | undefined;
	settledAtMs: number | undefined;
	/** settledAtMs - promptAtMs; setup before dispatch is reported separately. */
	wallMs: number;
	preflight: string | undefined;
	delegated: boolean;
	newRun: boolean;
	/** True when no new run appeared and a previous BENCH_OK/run would have been reused. */
	reusedPriorRun: boolean;
	runId: string | undefined;
	runIds: string[];
	toolNames: string[];
	parentAnswerText: string | undefined;
	tools: ToolRecord[];
	messages: MessageRecord[];
	bus: BusNotification[];
	busRawCount: number;
	parent: {
		usage: UsageCounts;
		modelCalls: number;
		providerRequests: number;
		costEstimate: number | undefined;
		perCall: Array<{ atMs: number; usage: UsageCounts | undefined; stopReason: string | undefined }>;
		finalContext: { input: number; cacheRead: number; cacheWrite: number; fullInput: number } | undefined;
	};
	child: RepeatChildReport;
	latency: {
		discoveryMs: number | undefined;
		dispatchMs: number | undefined;
		completionMs: number | undefined;
	};
	errors: string[];
}

export interface RepeatIntegrity {
	ok: boolean;
	sessionParent: UsageCounts;
	allocatedParent: UsageCounts;
	unattributedParent: UsageCounts;
	unattributedCost: number;
	providerRequestsTotal: number;
	allocatedProviderRequests: number;
	modelCallsTotal: number;
	allocatedModelCalls: number;
	notes: string[];
}

export interface RepeatSessionReport {
	session: number;
	valid: boolean;
	invalidReason?: string;
	startedAtIso: string;
	target: TargetInfo;
	mode: BenchMode;
	codemode: CodemodeState;
	cwd: string;
	model: ModelIdentity;
	build: BuildTimings;
	/** Build + presentation commands; excluded from per-iteration dispatch timing. */
	setupMs: number;
	activeTools: string[];
	systemPromptChars: number;
	systemPromptSha256: string;
	extensions: ExtensionDescription[];
	duplicateTools: DuplicateTool[];
	settings: SettingsDiagnostics;
	iterations: RepeatIterationReport[];
	cumulative: {
		validIterations: number;
		parent: UsageCounts;
		child: UsageCounts;
		costEstimate: number;
		fullInput: number;
		providerRequests: number;
		modelCalls: number;
		wallMs: number;
	};
	sessionTotals: {
		parent: UsageCounts;
		costEstimate: number;
		modelCalls: number;
		providerRequests: number;
	};
	integrity: RepeatIntegrity;
	bus: BusNotification[];
	/** Iteration after which the session loop aborted because a prior run would have been reused. */
	abortedAfter: number | undefined;
	errors: string[];
}

export interface RepeatReport {
	schema: typeof REPEAT_SCHEMA;
	harnessVersion: string;
	generatedAtIso: string;
	costProvenance: string;
	config: {
		sessions: number;
		turns: number;
		target: TargetInfo | undefined;
		mode: BenchMode;
		codemode: CodemodeState;
		provider: string;
		model: string;
		thinking: string;
		cwd: string;
		agentDir: string;
	};
	summary: RepeatSummary;
	sessions: RepeatSessionReport[];
	limitations: string[];
	notes: string[];
}

export interface RepeatDriver {
	probe: Probe;
	bus: BusNotification[];
	providerRequestCount(): number;
	dispatch(text: string): Promise<{ preflight: string | undefined; thrown: string | undefined }>;
	waitSettle(timeoutMs: number): Promise<boolean>;
	waitBusCompletion(runIds: string[], afterMs: number, timeoutMs: number): Promise<BusNotification | undefined>;
	waitIdle(quietMs: number, timeoutMs: number): Promise<boolean>;
	lastAssistantText(): string | undefined;
	findChild(sinceMs: number): { sessionFile: string; metrics: ChildSessionMetrics } | undefined;
}

export interface RepeatTimings {
	childTimeoutMs: number;
	settleTimeoutMs: number;
	quiesceMs: number;
}

function snapshotTools(probe: Probe, from: number): ToolRecord[] {
	return probe.tools.slice(from).map((tool) => ({ ...tool }));
}

function newRunsIn(tools: ToolRecord[], priorSeen: Set<string>): BenchRunSnapshot[] {
	return collectRuns(tools).filter((run) => !priorSeen.has(run.id));
}

export async function runRepeatIteration(
	driver: RepeatDriver,
	opts: BenchOptions,
	iteration: number,
	priorSeen: Set<string>,
	timings: RepeatTimings,
): Promise<RepeatIterationReport> {
	const errors: string[] = [];
	const fail = (condition: boolean, message: string): void => {
		if (condition) errors.push(message);
	};
	const messagesFrom = driver.probe.messages.length;
	const toolsFrom = driver.probe.tools.length;
	const busFrom = driver.bus.length;
	const requestsFrom = driver.providerRequestCount();
	const errorsFrom = driver.probe.errors.length;
	const prompt = repeatPrompt(opts, iteration);
	const promptWallAt = Date.now();
	const promptAtMs = driver.probe.now();
	const dispatch = await driver.dispatch(prompt);
	const promptReturnMs = driver.probe.now();
	fail(dispatch.thrown !== undefined, `prompt rejected: ${dispatch.thrown}`);
	fail(dispatch.preflight !== "started", `prompt preflight=${dispatch.preflight ?? "none"} (expected started)`);

	const provisional = newRunsIn(snapshotTools(driver.probe, toolsFrom), priorSeen);
	fail(provisional.length > 1, `multiple new runs before settle: ${provisional.map((run) => run.id).join(",")}`);
	const provisionalRunId = provisional[0]?.id;
	const provisionalCompletion =
		provisionalRunId !== undefined
			? await driver.waitBusCompletion([provisionalRunId], promptAtMs, timings.childTimeoutMs)
			: undefined;

	let settledAtMs = driver.probe.lastSettledAtMs;
	if (settledAtMs === undefined || settledAtMs < promptAtMs) {
		const settled = await driver.waitSettle(timings.settleTimeoutMs);
		settledAtMs = driver.probe.lastSettledAtMs;
		fail(!settled, `timeout waiting for agent_settled (${timings.settleTimeoutMs}ms)`);
	}
	const idle = await driver.waitIdle(timings.quiesceMs, timings.settleTimeoutMs);
	fail(!idle, `session did not go idle after ${timings.settleTimeoutMs}ms (delayed notices/follow-ups)`);
	settledAtMs = driver.probe.lastSettledAtMs;
	fail(settledAtMs === undefined || settledAtMs < promptAtMs, "no settlement for the current prompt");
	errors.push(...driver.probe.errors.slice(errorsFrom));

	const messages = driver.probe.messages.slice(messagesFrom);
	const tools = snapshotTools(driver.probe, toolsFrom);
	const busEvents = dedupeNotifications(driver.bus.slice(busFrom));
	const finalNew = newRunsIn(tools, priorSeen);
	const runId = finalNew.length === 1 ? finalNew[0]?.id : undefined;
	fail(finalNew.length === 0, "no new run for this iteration; a previous BENCH_OK must not be reused");
	fail(finalNew.length > 1, `multiple new runs in one iteration: ${finalNew.map((run) => run.id).join(",")}`);
	fail(
		provisional.length === 1 && finalNew.length === 1 && provisional[0]?.id !== finalNew[0]?.id,
		`run id changed during quiescence: ${provisional[0]?.id} -> ${finalNew[0]?.id}`,
	);
	const completion =
		provisionalCompletion ?? (runId !== undefined ? terminalNotificationIn(driver.bus, runId, promptAtMs) : undefined);
	if (runId !== undefined) {
		fail(completion === undefined, `no terminal completion notification for run ${runId}`);
		fail(
			completion !== undefined && completion.runId !== runId,
			`completion notification belongs to ${completion?.runId}, expected ${runId}`,
		);
	}
	for (const run of [...finalNew, ...provisional]) priorSeen.add(run.id);

	const childRun = finalNew.find((run) => run.id === runId) ?? finalNew[0];
	const task = childRun?.tasks.find((candidate) => candidate.status === "completed") ?? childRun?.tasks[0];
	fail(runId !== undefined && task === undefined, "correlated run snapshot has no task");
	let sessionFile = task?.sessionFile;
	let parsed = sessionFile !== undefined ? parseChildSessionFile(sessionFile) : undefined;
	if (parsed === null || parsed === undefined) {
		const found = driver.findChild(promptWallAt - 2000);
		if (found) {
			sessionFile = found.sessionFile;
			parsed = found.metrics;
		}
	}
	const childModel = task?.model ?? parsed?.model;
	const childProvider = task?.provider ?? parsed?.provider;
	const childThinking = task?.thinking ?? parsed?.thinkingLevel;
	const snapshotUsage = task?.usage;
	const snapshotNonZero =
		snapshotUsage !== undefined &&
		snapshotUsage.input +
			snapshotUsage.output +
			snapshotUsage.cacheRead +
			snapshotUsage.cacheWrite +
			snapshotUsage.totalTokens >
			0;
	const parsedUsable = parsed != null && parsed.assistantMessages > 0;
	const childUsage = snapshotNonZero ? snapshotUsage : parsedUsable ? parsed?.usage : undefined;
	const usageSource: RepeatChildReport["usageSource"] = snapshotNonZero
		? "run-snapshot"
		: parsedUsable
			? "session-file"
			: "none";
	const childToolCalls = task?.toolCalls ?? parsed?.toolCallCount;
	const childModelCalls =
		snapshotUsage?.turns !== undefined && snapshotUsage.turns > 0 ? snapshotUsage.turns : parsed?.assistantMessages;
	const childFinalText = task?.finalText ?? parsed?.finalText;
	const containsBenchOk = childFinalText?.trim() === "BENCH_OK";
	if (runId !== undefined) {
		const childProblems: Array<[boolean, string]> = [
			[childModel !== opts.model, `child model ${childModel ?? "?"} differs from controlled ${opts.model}`],
			[
				childProvider !== opts.provider,
				`child provider ${childProvider ?? "?"} differs from controlled ${opts.provider}`,
			],
			[
				childThinking !== opts.thinking,
				`child thinking ${childThinking ?? "?"} differs from controlled ${opts.thinking}`,
			],
			[usageSource === "none", "child usage unavailable (no run snapshot, no persisted child session)"],
			[containsBenchOk !== true, "child BENCH_OK not observed in this iteration"],
			[childToolCalls === undefined, "child tool-call count unknown"],
			[
				childToolCalls !== undefined && childToolCalls > 0,
				`controlled child used ${childToolCalls} tool call(s); benchmark requires 0`,
			],
			[childModelCalls !== 1, `child model calls ${childModelCalls ?? "unknown"}; benchmark requires 1`],
			[
				childRun?.tasks.length !== 1,
				`correlated run has ${childRun?.tasks.length ?? 0} task(s); benchmark requires exactly 1`,
			],
			[task?.status !== "completed", `child task status ${task?.status ?? "unknown"}; expected completed`],
			[task?.branch !== undefined, `child ran on branch ${task?.branch}; benchmark requires no worktree`],
		];
		for (const [problem, message] of childProblems) fail(problem, message);
	}

	const subagentTool =
		tools.find((tool) => tool.toolName === "subagent" && tool.run !== undefined) ??
		tools.find((tool) => tool.toolName === "subagent");
	fail(subagentTool === undefined, "no subagent tool call captured in this iteration");
	fail(
		subagentTool !== undefined && !matchesControlledArguments(subagentTool.argsPreview, controlledArguments(opts)),
		"controlled child arguments changed or were not captured for this iteration",
	);
	const parentUsage = usageBreakdown(messages);
	const lastAssistant = [...messages]
		.reverse()
		.find((message) => message.role === "assistant" && message.usage !== undefined);
	const providerRequests = driver.providerRequestCount() - requestsFrom;
	fail(parentUsage.calls === 0, "no parent model call observed in this iteration");
	fail(parentUsage.fullInput <= 0, "parent model call reported no input tokens");
	fail(providerRequests === 0, "no parent provider request observed in this iteration");
	const assistantMessages = messages.filter((message) => message.role === "assistant");
	fail(
		assistantMessages.some((message) => message.usage === undefined),
		"parent usage unavailable",
	);
	fail(
		assistantMessages.some((message) => message.stopReason === "error" || message.stopReason === "aborted"),
		"parent model failed or aborted",
	);
	fail(
		tools.some((tool) => tool.isError),
		"tool execution failed",
	);
	fail(providerRequests !== parentUsage.calls, "provider requests differ from model calls (retry or missing usage)");
	const parentCost = Number.isFinite(parentUsage.total.cost) ? parentUsage.total.cost : undefined;
	const childCost = childUsage && Number.isFinite(childUsage.cost) ? childUsage.cost : undefined;
	fail(parentCost === undefined, "parent cost unavailable");
	fail(childCost === undefined, "child cost unavailable");

	const valid = errors.length === 0;
	return {
		iteration,
		valid,
		invalidReason: valid ? undefined : errors.join("; "),
		prompt,
		promptAtMs,
		promptReturnMs,
		settledAtMs,
		wallMs: (settledAtMs ?? driver.probe.now()) - promptAtMs,
		preflight: dispatch.preflight,
		delegated: runId !== undefined,
		newRun: runId !== undefined,
		reusedPriorRun: finalNew.length === 0,
		runId,
		runIds: finalNew.map((run) => run.id),
		toolNames: tools.map((tool) => tool.toolName),
		parentAnswerText: driver.lastAssistantText(),
		tools,
		messages,
		bus: busEvents,
		busRawCount: driver.bus.length - busFrom,
		parent: {
			usage: parentUsage.total,
			modelCalls: parentUsage.calls,
			providerRequests,
			costEstimate: parentCost,
			perCall: parentUsage.perCall.map((call) => ({
				atMs: call.atMs,
				usage: call.usage,
				stopReason: call.stopReason,
			})),
			finalContext: lastAssistant?.usage
				? {
						input: lastAssistant.usage.input,
						cacheRead: lastAssistant.usage.cacheRead,
						cacheWrite: lastAssistant.usage.cacheWrite,
						fullInput: fullInputOf(lastAssistant.usage),
					}
				: undefined,
		},
		child: {
			runId,
			status: task?.status ?? childRun?.status,
			model: childModel,
			provider: childProvider,
			thinking: childThinking,
			sessionFile,
			branch: task?.branch,
			usage: childUsage,
			usageSource,
			costEstimate: childCost,
			toolCalls: childToolCalls,
			modelCalls: childModelCalls,
			finalText: childFinalText,
			containsBenchOk,
		},
		latency: {
			discoveryMs: subagentTool !== undefined ? subagentTool.startMs - promptAtMs : undefined,
			dispatchMs: subagentTool?.endMs !== undefined ? subagentTool.endMs - subagentTool.startMs : undefined,
			completionMs: completion !== undefined ? completion.atMs - promptAtMs : undefined,
		},
		errors,
	};
}

export interface RepeatDelegationResult {
	iterations: RepeatIterationReport[];
	seenRunIds: string[];
	abortedAfter: number | undefined;
}

export async function runRepeatedDelegations(
	driver: RepeatDriver,
	opts: BenchOptions,
	turns: number,
	quiesceMs = DEFAULT_QUIESCE_MS,
): Promise<RepeatDelegationResult> {
	const priorSeen = new Set<string>();
	const iterations: RepeatIterationReport[] = [];
	const timings: RepeatTimings = {
		childTimeoutMs: opts.childTimeoutMs,
		settleTimeoutMs: opts.settleTimeoutMs,
		quiesceMs,
	};
	let abortedAfter: number | undefined;
	for (let iteration = 1; iteration <= turns; iteration++) {
		const report = await runRepeatIteration(driver, opts, iteration, priorSeen, timings);
		iterations.push(report);
		if (!report.valid && report.reusedPriorRun) {
			abortedAfter = iteration;
			break;
		}
	}
	return { iterations, seenRunIds: [...priorSeen], abortedAfter };
}

export async function waitForIdle(
	session: Pick<AgentSession, "isIdle" | "isStreaming">,
	notifications: BusNotification[],
	quietMs: number,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = performance.now() + timeoutMs;
	let lastCount = notifications.length;
	let lastChange = performance.now();
	for (;;) {
		if (session.isIdle && !session.isStreaming && performance.now() - lastChange >= quietMs) return true;
		if (performance.now() >= deadline) return false;
		await sleep(100);
		if (notifications.length !== lastCount) {
			lastCount = notifications.length;
			lastChange = performance.now();
		}
	}
}

function reportedCost(usage: unknown): boolean {
	if (!usage || typeof usage !== "object") return false;
	const raw = usage as { cost?: number | { total?: number } };
	const cost = typeof raw.cost === "number" ? raw.cost : raw.cost?.total;
	return typeof cost === "number" && Number.isFinite(cost) && cost >= 0;
}

export function recordRepeatEvent(probe: Probe, event: AgentSessionEvent): void {
	probe.handle(event);
	const raw = event as unknown as {
		type: string;
		message?: { role?: string; usage?: unknown };
		result?: { details?: { run?: { tasks?: Array<{ usage?: unknown }> } } };
	};
	if (raw.type === "message_end" && raw.message?.role === "assistant" && !reportedCost(raw.message.usage)) {
		probe.errors.push("parent cost unavailable in raw usage");
	}
	if (raw.type === "tool_execution_end") {
		for (const task of raw.result?.details?.run?.tasks ?? []) {
			if (task.usage !== undefined && !reportedCost(task.usage))
				probe.errors.push("child cost unavailable in raw usage");
		}
	}
}

function liveRepeatDriver(built: BuiltSession, probe: Probe, bus: BusNotification[], agentDir: string): RepeatDriver {
	return {
		probe,
		bus,
		providerRequestCount: () => built.providerRequests.length,
		dispatch: async (text: string) => {
			const preflight: { value: string | undefined } = { value: undefined };
			let thrown: string | undefined;
			try {
				await built.session.prompt(text, {
					preflightResult: (disposition) => {
						preflight.value = disposition;
					},
				});
			} catch (error) {
				thrown = errorMessage(error);
			}
			return { preflight: preflight.value, thrown };
		},
		waitSettle: (timeoutMs: number) => waitForSettle(built.session, timeoutMs),
		waitBusCompletion: (runIds: string[], afterMs: number, timeoutMs: number) =>
			waitForBusCompletion(bus, runIds, afterMs, timeoutMs),
		waitIdle: (quietMs: number, timeoutMs: number) => waitForIdle(built.session, bus, quietMs, timeoutMs),
		lastAssistantText: () => built.session.getLastAssistantText(),
		findChild: (sinceMs: number) => findChildSession(agentDir, sinceMs),
	};
}

export interface RepeatSessionInput {
	ctx: RunContext;
	sessionIndex: number;
	turns: number;
	quiesceMs?: number;
}

export function computeIntegrity(input: {
	sessionParent: UsageCounts;
	allocatedParent: UsageCounts;
	providerRequestsTotal: number;
	allocatedProviderRequests: number;
	modelCallsTotal: number;
	allocatedModelCalls: number;
}): RepeatIntegrity {
	const unattributed = emptyUsage();
	const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
	const notes: string[] = [];
	let ok = true;
	for (const field of fields) {
		const delta = input.sessionParent[field] - input.allocatedParent[field];
		unattributed[field] = delta;
		if (delta < 0) {
			ok = false;
			notes.push(`allocated ${field} exceeds session total by ${-delta}`);
		} else if (delta > 0) {
			notes.push(`${field} not attributed to iterations: ${delta}`);
		}
	}
	unattributed.cost = input.sessionParent.cost - input.allocatedParent.cost;
	if (unattributed.cost < -1e-9) {
		ok = false;
		notes.push(`allocated cost exceeds session total by ${(-unattributed.cost).toFixed(6)}`);
	} else if (unattributed.cost > 1e-9) {
		notes.push(`cost not attributed to iterations: ${unattributed.cost.toFixed(6)}`);
	}
	const requestDelta = input.providerRequestsTotal - input.allocatedProviderRequests;
	if (requestDelta < 0) {
		ok = false;
		notes.push(`allocated provider requests exceed session total by ${-requestDelta}`);
	} else if (requestDelta > 0) {
		notes.push(`provider requests not attributed to iterations: ${requestDelta}`);
	}
	const callDelta = input.modelCallsTotal - input.allocatedModelCalls;
	if (callDelta < 0) {
		ok = false;
		notes.push(`allocated model calls exceed session total by ${-callDelta}`);
	} else if (callDelta > 0) {
		notes.push(`model calls not attributed to iterations: ${callDelta}`);
	}
	return {
		ok,
		sessionParent: input.sessionParent,
		allocatedParent: input.allocatedParent,
		unattributedParent: unattributed,
		unattributedCost: unattributed.cost,
		providerRequestsTotal: input.providerRequestsTotal,
		allocatedProviderRequests: input.allocatedProviderRequests,
		modelCallsTotal: input.modelCallsTotal,
		allocatedModelCalls: input.allocatedModelCalls,
		notes,
	};
}

function failedRepeatSession(
	ctx: RunContext,
	sessionIndex: number,
	startedAtIso: string,
	reason: string,
): RepeatSessionReport {
	const empty = emptyUsage();
	return {
		session: sessionIndex,
		valid: false,
		invalidReason: reason,
		startedAtIso,
		target: skeletonTarget(ctx),
		mode: ctx.opts.mode,
		codemode: ctx.opts.codemode,
		cwd: ctx.opts.cwd,
		model: {
			provider: ctx.opts.provider,
			id: ctx.opts.model,
			name: "unresolved",
			contextWindow: undefined,
			thinkingLevel: ctx.opts.thinking,
		},
		build: { modelRuntimeMs: 0, settingsMs: 0, loaderMs: 0, sessionCreateMs: 0, bindExtensionsMs: 0, totalMs: 0 },
		setupMs: 0,
		activeTools: [],
		systemPromptChars: 0,
		systemPromptSha256: "",
		extensions: [],
		duplicateTools: [],
		settings: {
			agentDir: ctx.agentDir,
			packagesConfigured: [],
			packagesLoaded: [],
			packagesRemoved: [],
			defaultToolsBefore: undefined,
			defaultToolsAfter: undefined,
			codemodeMode: undefined,
			codemodeNote: `codemode=${ctx.opts.codemode}`,
			extensionsSetting: undefined,
		},
		iterations: [],
		cumulative: {
			validIterations: 0,
			parent: empty,
			child: emptyUsage(),
			costEstimate: 0,
			fullInput: 0,
			providerRequests: 0,
			modelCalls: 0,
			wallMs: 0,
		},
		sessionTotals: { parent: empty, costEstimate: 0, modelCalls: 0, providerRequests: 0 },
		integrity: computeIntegrity({
			sessionParent: empty,
			allocatedParent: empty,
			providerRequestsTotal: 0,
			allocatedProviderRequests: 0,
			modelCallsTotal: 0,
			allocatedModelCalls: 0,
		}),
		bus: [],
		abortedAfter: undefined,
		errors: [reason],
	};
}

export async function runRepeatSession(input: RepeatSessionInput): Promise<RepeatSessionReport> {
	const { ctx, sessionIndex, turns } = input;
	const opts = ctx.opts;
	const sessionStart = performance.now();
	const startedAtIso = new Date().toISOString();
	let built: BuiltSession;
	try {
		built = await buildParentSession({ opts });
	} catch (error) {
		return failedRepeatSession(ctx, sessionIndex, startedAtIso, `session build failed: ${errorMessage(error)}`);
	}
	const probe = new Probe(sessionStart);
	const unsubscribe = built.session.subscribe((event) => recordRepeatEvent(probe, event));
	const bus = captureBusNotifications(built.eventBus, sessionStart);
	const errors: string[] = [];
	try {
		if (!promptEmbedsControlledArguments(opts))
			errors.push("--delegate-prompt does not embed the controlled child arguments");
		if (errors.length === 0) {
			try {
				await applyPresentationCommands(built, probe, opts, errors);
			} catch (error) {
				errors.push(`presentation setup failed: ${errorMessage(error)}`);
			}
		}
		const setupMs = probe.now();
		const activeTools = built.session.getActiveToolNames().slice().sort();
		const systemPrompt = built.session.systemPrompt ?? "";
		const iterations: RepeatIterationReport[] = [];
		let abortedAfter: number | undefined;
		if (errors.length === 0) {
			const driver = liveRepeatDriver(built, probe, bus.notifications, ctx.agentDir);
			const result = await runRepeatedDelegations(driver, opts, turns, input.quiesceMs ?? DEFAULT_QUIESCE_MS);
			iterations.push(...result.iterations);
			abortedAfter = result.abortedAfter;
			if (abortedAfter !== undefined) {
				errors.push(`aborted after iteration ${abortedAfter}: a previous run would have been reused`);
			}
		}
		if (iterations.length !== turns) errors.push(`expected ${turns} iterations, got ${iterations.length}`);

		const sessionUsage = usageBreakdown(probe.messages);
		const allocated = emptyUsage();
		const allocatedChild = emptyUsage();
		let allocatedRequests = 0;
		let allocatedCalls = 0;
		for (const iteration of iterations) {
			addUsage(allocated, iteration.parent.usage);
			if (iteration.child.usage !== undefined) addUsage(allocatedChild, iteration.child.usage);
			allocatedRequests += iteration.parent.providerRequests;
			allocatedCalls += iteration.parent.modelCalls;
		}
		const integrity = computeIntegrity({
			sessionParent: sessionUsage.total,
			allocatedParent: allocated,
			providerRequestsTotal: built.providerRequests.length,
			allocatedProviderRequests: allocatedRequests,
			modelCallsTotal: probe.assistantCalls(),
			allocatedModelCalls: allocatedCalls,
		});
		if (!integrity.ok) errors.push("usage attribution integrity failed: allocated totals exceed session totals");
		const cumulative = {
			validIterations: iterations.filter((iteration) => iteration.valid).length,
			parent: allocated,
			child: allocatedChild,
			costEstimate: allocated.cost + allocatedChild.cost,
			fullInput: fullInputOf(allocated) + fullInputOf(allocatedChild),
			providerRequests: allocatedRequests,
			modelCalls: allocatedCalls,
			wallMs: iterations.reduce((sum, iteration) => sum + iteration.wallMs, 0),
		};
		const invalidReasons = [
			...errors,
			...iterations
				.filter((iteration) => !iteration.valid)
				.map((iteration) => `iteration ${iteration.iteration}: ${iteration.invalidReason ?? "invalid"}`),
		];
		const valid = errors.length === 0 && iterations.length === turns && invalidReasons.length === 0;
		const invalidReason = valid
			? undefined
			: invalidReasons.length > 0
				? invalidReasons.join("; ")
				: "one or more iterations invalid";
		return {
			session: sessionIndex,
			valid,
			invalidReason,
			startedAtIso,
			target: skeletonTarget(ctx),
			mode: opts.mode,
			codemode: opts.codemode,
			cwd: opts.cwd,
			model: built.model,
			build: built.timings,
			setupMs,
			activeTools,
			systemPromptChars: systemPrompt.length,
			systemPromptSha256: createHash("sha256").update(systemPrompt).digest("hex"),
			extensions: built.extensions,
			duplicateTools: built.duplicateTools,
			settings: built.settings,
			iterations,
			cumulative,
			sessionTotals: {
				parent: sessionUsage.total,
				costEstimate: sessionUsage.total.cost,
				modelCalls: probe.assistantCalls(),
				providerRequests: built.providerRequests.length,
			},
			integrity,
			bus: dedupeNotifications(bus.notifications),
			abortedAfter,
			errors,
		};
	} finally {
		unsubscribe();
		bus.unsubscribe();
		built.dispose();
	}
}
