import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type BenchMode, type BenchOptions, type CodemodeState, resolveOptions } from "./args.ts";
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
import { type Distribution, distribution, usageBreakdown } from "./report.ts";
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

export type RepeatMetricUnit = "ms" | "tokens" | "usd" | "count";

export interface RepeatMetricExtractor {
	metric: string;
	unit: RepeatMetricUnit;
	pick: (iteration: RepeatIterationReport) => number | undefined;
}

export const REPEAT_METRICS: RepeatMetricExtractor[] = [
	{ metric: "dispatchToSettleMs", unit: "ms", pick: (it) => it.wallMs },
	{ metric: "discoveryMs", unit: "ms", pick: (it) => it.latency.discoveryMs },
	{ metric: "completionMs", unit: "ms", pick: (it) => it.latency.completionMs },
	{ metric: "parentFullInput", unit: "tokens", pick: (it) => fullInputOf(it.parent.usage) },
	{ metric: "parentUncachedInput", unit: "tokens", pick: (it) => it.parent.usage.input },
	{ metric: "parentCacheRead", unit: "tokens", pick: (it) => it.parent.usage.cacheRead },
	{ metric: "parentCacheWrite", unit: "tokens", pick: (it) => it.parent.usage.cacheWrite },
	{ metric: "parentOutput", unit: "tokens", pick: (it) => it.parent.usage.output },
	{ metric: "parentModelCalls", unit: "count", pick: (it) => it.parent.modelCalls },
	{ metric: "parentProviderRequests", unit: "count", pick: (it) => it.parent.providerRequests },
	{ metric: "parentCostEstimate", unit: "usd", pick: (it) => it.parent.costEstimate },
	{
		metric: "childFullInput",
		unit: "tokens",
		pick: (it) => (it.child.usage ? fullInputOf(it.child.usage) : undefined),
	},
	{ metric: "childUncachedInput", unit: "tokens", pick: (it) => it.child.usage?.input },
	{ metric: "childCacheRead", unit: "tokens", pick: (it) => it.child.usage?.cacheRead },
	{ metric: "childCacheWrite", unit: "tokens", pick: (it) => it.child.usage?.cacheWrite },
	{ metric: "childOutput", unit: "tokens", pick: (it) => it.child.usage?.output },
	{ metric: "childModelCalls", unit: "count", pick: (it) => it.child.modelCalls },
	{ metric: "childCostEstimate", unit: "usd", pick: (it) => it.child.costEstimate },
	{
		metric: "totalCostEstimate",
		unit: "usd",
		pick: (it) =>
			it.parent.costEstimate !== undefined && it.child.costEstimate !== undefined
				? it.parent.costEstimate + it.child.costEstimate
				: undefined,
	},
	{
		metric: "totalFullInput",
		unit: "tokens",
		pick: (it) => fullInputOf(it.parent.usage) + (it.child.usage ? fullInputOf(it.child.usage) : 0),
	},
];

export interface RepeatEpochStat {
	scope: "first" | "later" | "cumulative" | "position";
	position?: number;
	calls: number;
	/** One value per session (first value, later mean, session sum, or value at one position). */
	bySession: Array<number | undefined>;
	sessionDistribution: Distribution | undefined;
	/** Naive call-level values; not independent samples when positions repeat within a session. */
	pooled: number[];
	pooledDistribution: Distribution | undefined;
}

export interface RepeatMetricSummary {
	metric: string;
	unit: RepeatMetricUnit;
	first: RepeatEpochStat;
	later: RepeatEpochStat;
	cumulative: RepeatEpochStat;
	positions: RepeatEpochStat[];
}

export interface RepeatSessionLike {
	iterations: RepeatIterationReport[];
	setupMs: number;
}

export interface RepeatSummary {
	sessions: number;
	turns: number;
	totalIterations: number;
	validIterations: number;
	setupMs: { bySession: number[]; distribution: Distribution | undefined };
	metrics: RepeatMetricSummary[];
	notes: string[];
}

function isNumber(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function mean(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function epochStat(
	scope: RepeatEpochStat["scope"],
	bySession: Array<number | undefined>,
	pooled: number[],
	position?: number,
): RepeatEpochStat {
	return {
		scope,
		...(position === undefined ? {} : { position }),
		calls: pooled.length,
		bySession,
		sessionDistribution: distribution(bySession.map((value) => value ?? Number.NaN)),
		pooled,
		pooledDistribution: distribution(pooled),
	};
}

export function buildRepeatSummary(sessions: RepeatSessionLike[]): RepeatSummary {
	const turns = Math.max(0, ...sessions.map((session) => session.iterations.length));
	const metrics = REPEAT_METRICS.map((extractor) => {
		const firstBySession = sessions.map((session) => {
			const iteration = session.iterations.find((candidate) => candidate.iteration === 1);
			return iteration?.valid ? extractor.pick(iteration) : undefined;
		});
		const laterValuesBySession = sessions.map((session) =>
			session.iterations
				.filter((iteration) => iteration.valid && iteration.iteration >= 2)
				.map(extractor.pick)
				.filter(isNumber),
		);
		const laterBySession = laterValuesBySession.map((values) => (values.length > 0 ? mean(values) : undefined));
		const cumulativeBySession = sessions.map((session) => {
			const values = session.iterations
				.filter((iteration) => iteration.valid)
				.map(extractor.pick)
				.filter(isNumber);
			return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
		});
		const positions: RepeatEpochStat[] = [];
		for (let position = 1; position <= Math.max(turns, 1); position++) {
			const bySession = sessions.map((session) => {
				const iteration = session.iterations.find((candidate) => candidate.iteration === position);
				return iteration?.valid ? extractor.pick(iteration) : undefined;
			});
			positions.push(epochStat("position", bySession, bySession.filter(isNumber), position));
		}
		return {
			metric: extractor.metric,
			unit: extractor.unit,
			first: epochStat("first", firstBySession, firstBySession.filter(isNumber)),
			later: epochStat("later", laterBySession, laterValuesBySession.flat()),
			cumulative: epochStat("cumulative", cumulativeBySession, cumulativeBySession.filter(isNumber)),
			positions,
		};
	});
	const setupBySession = sessions.map((session) => session.setupMs);
	return {
		sessions: sessions.length,
		turns,
		totalIterations: sessions.reduce((sum, session) => sum + session.iterations.length, 0),
		validIterations: sessions.reduce(
			(sum, session) => sum + session.iterations.filter((iteration) => iteration.valid).length,
			0,
		),
		setupMs: { bySession: setupBySession, distribution: distribution(setupBySession) },
		metrics,
		notes: [
			"first/later/cumulative values are session-level aggregates; pooled call values are shown for transparency but repeat within one conversation and are not independent samples.",
			"cost figures are SDK usage catalog estimates, not provider invoices.",
			"invalid iterations are reported and never filtered or retried; comparisons include only valid iterations.",
		],
	};
}

export interface SyntheticIteration {
	runId?: string;
	extraRunIds?: string[];
	/** Reuse the previous run id instead of spawning a new run (invalid: no new run). */
	noNewRun?: boolean;
	parentCalls?: number;
	parentInput?: number;
	parentCacheRead?: number;
	parentCacheWrite?: number;
	parentOutput?: number;
	parentCost?: number;
	parentFinalText?: string;
	childInput?: number;
	childCacheRead?: number;
	childCacheWrite?: number;
	childOutput?: number;
	childCost?: number;
	childModelCalls?: number;
	childToolCalls?: number;
	childFinalText?: string;
	branch?: string;
	delayedFollowUp?: boolean;
}

function syntheticRun(runId: string, step: SyntheticIteration, opts: BenchOptions, atMs: number): BenchRunSnapshot {
	const usage = {
		input: step.childInput ?? 40,
		output: step.childOutput ?? 4,
		cacheRead: step.childCacheRead ?? 0,
		cacheWrite: step.childCacheWrite ?? 0,
		totalTokens: 0,
		cost: { total: step.childCost ?? 0.00002 },
		turns: step.childModelCalls ?? 1,
	};
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return {
		id: runId,
		mode: "parallel",
		status: "completed",
		createdAt: atMs,
		startedAt: atMs,
		endedAt: atMs + 1,
		tasks: [
			{
				id: `${runId}_task`,
				agent: "bench-contract-worker",
				status: "completed",
				task: "Reply with exactly BENCH_OK.",
				sessionId: `${runId}_session`,
				sessionFile: undefined,
				startedAt: atMs,
				endedAt: atMs + 1,
				toolCalls: step.childToolCalls ?? 0,
				usage: usage as unknown as BenchRunSnapshot["tasks"][number]["usage"],
				finalText: step.childFinalText ?? "BENCH_OK",
				error: undefined,
				model: opts.model,
				provider: opts.provider,
				thinking: opts.thinking,
				tools: [],
				branch: step.branch,
				isolation: "none",
			},
		],
	};
}

export interface SyntheticDriverHandle {
	driver: RepeatDriver;
	dispatchedPrompts: string[];
	emittedRunIds: string[];
}

export function makeSyntheticRepeatDriver(opts: BenchOptions, script: SyntheticIteration[]): SyntheticDriverHandle {
	const probe = new Probe(performance.now());
	const bus: BusNotification[] = [];
	const dispatchedPrompts: string[] = [];
	const emittedRunIds: string[] = [];
	const controlled = JSON.stringify(controlledArguments(opts));
	let providerRequests = 0;
	let dispatched = 0;
	let lastRunId: string | undefined;
	let lastText: string | undefined;

	const pushAssistant = (text: string, step: SyntheticIteration): void => {
		probe.handle({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: text ? [{ type: "text", text }] : [],
				usage: {
					input: step.parentInput ?? 100,
					output: step.parentOutput ?? 10,
					cacheRead: step.parentCacheRead ?? 0,
					cacheWrite: step.parentCacheWrite ?? 0,
					totalTokens: (step.parentInput ?? 100) + (step.parentOutput ?? 10),
					cost: { total: step.parentCost ?? 0.0005 },
				},
			},
		} as unknown as AgentSessionEvent);
		lastText = text;
	};

	const emitRun = (toolCallId: string, runId: string, step: SyntheticIteration): void => {
		if (!emittedRunIds.includes(runId)) emittedRunIds.push(runId);
		probe.handle({
			type: "tool_execution_start",
			toolCallId,
			toolName: "subagent",
			args: JSON.parse(controlled),
			parentToolCallId: `call-${dispatched - 1}`,
		} as unknown as AgentSessionEvent);
		probe.handle({
			type: "tool_execution_end",
			toolCallId,
			toolName: "subagent",
			isError: false,
			result: {
				content: [{ type: "text", text: step.childFinalText ?? "BENCH_OK" }],
				details: { run: syntheticRun(runId, step, opts, probe.now()) },
			},
		} as unknown as AgentSessionEvent);
	};

	const driver: RepeatDriver = {
		probe,
		bus,
		providerRequestCount: () => providerRequests,
		dispatch: async (text: string) => {
			dispatchedPrompts.push(text);
			const index = dispatched;
			dispatched += 1;
			if (!text.includes(controlled))
				return { preflight: "started", thrown: "synthetic prompt missing controlled arguments" };
			const step = script[index] ?? {};
			const parentCalls = step.parentCalls ?? 2;
			providerRequests += parentCalls;
			for (let call = 0; call < parentCalls; call++) {
				pushAssistant(call === parentCalls - 1 ? (step.parentFinalText ?? "BENCH_OK") : "", step);
			}
			const runId = step.noNewRun ? lastRunId : (step.runId ?? `run_s${index + 1}`);
			probe.handle({
				type: "tool_execution_start",
				toolCallId: `call-${index}`,
				toolName: "codemode",
				args: { code: "tools.subagent(...)" },
			} as unknown as AgentSessionEvent);
			if (runId !== undefined) {
				lastRunId = runId;
				emitRun(`call-${index}/1`, runId, step);
				for (const extra of step.extraRunIds ?? []) emitRun(`call-${index}/extra-${extra}`, extra, step);
				bus.push({ atMs: probe.now(), runId, taskId: `${runId}_task`, kind: "completed", body: "done" });
			}
			probe.handle({
				type: "tool_execution_end",
				toolCallId: `call-${index}`,
				toolName: "codemode",
				isError: false,
				result: { content: [] },
			} as unknown as AgentSessionEvent);
			probe.handle({ type: "agent_settled" } as unknown as AgentSessionEvent);
			return { preflight: "started", thrown: undefined };
		},
		waitSettle: async () => true,
		waitBusCompletion: (runIds: string[], afterMs: number, timeoutMs: number) =>
			waitForBusCompletion(bus, runIds, afterMs, timeoutMs),
		waitIdle: async () => {
			const step = script[dispatched - 1];
			if (step?.delayedFollowUp) {
				providerRequests += 1;
				pushAssistant("delayed follow-up", {
					parentInput: 7,
					parentOutput: 0,
					parentCost: 0.00001,
					parentCacheRead: 0,
					parentCacheWrite: 0,
				});
				bus.push({
					atMs: probe.now(),
					runId: `delayed_${dispatched}`,
					taskId: undefined,
					kind: "completed",
					body: "delayed",
				});
			}
			return true;
		},
		lastAssistantText: () => lastText,
		findChild: () => undefined,
	};
	return { driver, dispatchedPrompts, emittedRunIds };
}

class RepeatChecks {
	count = 0;
	async run(label: string, fn: () => void | Promise<void>): Promise<void> {
		this.count += 1;
		try {
			await fn();
		} catch (error) {
			throw new Error(`repeat self-test failed: ${label}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export async function runRepeatSelfTest(): Promise<number> {
	const checks = new RepeatChecks();
	const opts = resolveOptions(["--dry-run"]);
	if (!opts) throw new Error("self-test options unavailable");
	await checks.run("prompt numbering keeps controlled child arguments identical", () => {
		const first = repeatPrompt(opts, 1);
		const second = repeatPrompt(opts, 2);
		assert(first.includes("delegation 1"), "first prompt numbered");
		assert(second.includes("delegation 2"), "second prompt numbered");
		assert(first.includes(JSON.stringify(controlledArguments(opts))), "first prompt embeds exact arguments");
		assert(second.includes(JSON.stringify(controlledArguments(opts))), "second prompt embeds exact arguments");
		assert(promptEmbedsControlledArguments(opts), "default delegate prompt embeds arguments");
	});
	await checks.run("three repeated delegations correlate exact new runs and partition usage", async () => {
		const { driver } = makeSyntheticRepeatDriver(opts, [
			{ runId: "run_a", parentInput: 100, parentCacheWrite: 5, childCacheWrite: 3 },
			{ runId: "run_b", parentInput: 120, parentCacheWrite: 0, childCacheWrite: 1 },
			{ runId: "run_c", parentInput: 140, parentCacheWrite: 2, childCacheWrite: 0 },
		]);
		const { iterations } = await runRepeatedDelegations(driver, opts, 3, 0);
		assert(
			iterations.every((iteration) => iteration.valid),
			`all iterations valid: ${iterations.map((it) => it.invalidReason).join("; ")}`,
		);
		assert(
			iterations.map((iteration) => iteration.runId).join(",") === "run_a,run_b,run_c",
			"exact run ids correlated in order",
		);
		assert(iterations[1]?.parent.usage.input === 240, "iteration 2 counts only its own parent messages");
		assert(iterations[1]?.parent.usage.cacheWrite === 0, "cacheWrite attributed to the right iteration");
		const summary = buildRepeatSummary([{ iterations, setupMs: 10 }]);
		const cacheWrite = summary.metrics.find((metric) => metric.metric === "parentCacheWrite");
		assert(
			cacheWrite?.cumulative.bySession[0] === 14,
			`cumulative cacheWrite adds once per call, got ${cacheWrite?.cumulative.bySession[0]}`,
		);
		const laterInput = summary.metrics.find((metric) => metric.metric === "parentUncachedInput")?.later;
		assert(laterInput?.bySession[0] === 260, "later mean is clustered per session");
	});
	await checks.run("previous BENCH_OK without a new run invalidates that iteration", async () => {
		const { driver } = makeSyntheticRepeatDriver(opts, [
			{ runId: "run_a" },
			{ noNewRun: true, parentFinalText: "BENCH_OK" },
		]);
		const { iterations } = await runRepeatedDelegations(driver, opts, 2, 0);
		assert(iterations[0]?.valid === true, "first iteration valid");
		assert(iterations[1]?.valid === false, "repeated BENCH_OK without a new run invalid");
		assert(iterations[1]?.invalidReason?.includes("no new run") === true, "no-new-run reason recorded");
	});
	await checks.run("multiple new runs in one iteration and bad child shapes are invalid", async () => {
		const { driver } = makeSyntheticRepeatDriver(opts, [
			{ runId: "run_a", extraRunIds: ["run_extra"] },
			{ runId: "run_b", childToolCalls: 1 },
			{ runId: "run_c", childModelCalls: 2, branch: "bench/x" },
		]);
		const { iterations } = await runRepeatedDelegations(driver, opts, 3, 0);
		assert(iterations[0]?.invalidReason?.includes("multiple new runs") === true, "multiple runs invalid");
		assert(iterations[1]?.invalidReason?.includes("tool call") === true, "child tool call invalid");
		assert(iterations[2]?.invalidReason?.includes("model calls") === true, "child model calls invalid");
		assert(iterations[2]?.invalidReason?.includes("worktree") === true, "child branch invalid");
	});
	await checks.run("delayed follow-ups land in the iteration that caused them", async () => {
		const { driver } = makeSyntheticRepeatDriver(opts, [
			{ runId: "run_a", parentInput: 100, delayedFollowUp: true },
			{ runId: "run_b", parentInput: 200 },
		]);
		const { iterations } = await runRepeatedDelegations(driver, opts, 2, 0);
		assert(iterations[0]?.parent.usage.input === 207, "delayed follow-up counted once in iteration 1");
		assert(iterations[1]?.parent.usage.input === 400, "iteration 2 does not re-count iteration 1 follow-up");
	});
	await checks.run("notification payload duplicates are deduped", () => {
		const notification: BusNotification = { atMs: 1, runId: "run_a", taskId: "t", kind: "completed", body: "done" };
		const deduped = dedupeNotifications([
			notification,
			{ ...notification, atMs: 2 },
			{ ...notification, runId: "run_b" },
		]);
		assert(deduped.length === 2, `expected 2 notifications, got ${deduped.length}`);
	});
	await checks.run("integrity rejects double counting", () => {
		const sessionUsage = emptyUsage();
		const allocated = emptyUsage();
		allocated.input = 10;
		allocated.cost = 0.01;
		const integrity = computeIntegrity({
			sessionParent: sessionUsage,
			allocatedParent: allocated,
			providerRequestsTotal: 1,
			allocatedProviderRequests: 2,
			modelCallsTotal: 1,
			allocatedModelCalls: 1,
		});
		assert(integrity.ok === false, "negative unattributed usage invalidates");
	});
	console.log(`repeat self-test OK (${checks.count} checks, no API calls)`);
	return 0;
}
