import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BenchOptions } from "./args.ts";
import { controlledArguments, matchesControlledArguments } from "./contract.ts";
import {
	argsFlag,
	type BusNotification,
	captureBusNotifications,
	collectRuns,
	findChildSession,
	Probe,
	parseChildSessionFile,
	pickRunSnapshot,
	routingSequence,
} from "./probe.ts";
import { type DelegateSampleReport, declaredManifest, type StartupSampleReport, usageBreakdown } from "./report.ts";
import {
	type BuiltSession,
	buildParentSession,
	commandRegistered,
	type ExtensionDescription,
	type ModelIdentity,
	modeCommandText,
	type SettingsDiagnostics,
	type TargetInfo,
} from "./session.ts";

export interface RunContext {
	opts: BenchOptions;
	target: TargetInfo | undefined;
	agentDir: string;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function skeletonTarget(ctx: RunContext): TargetInfo {
	return (
		ctx.target ?? {
			path: "(none)",
			exists: false,
			bytes: undefined,
			mtimeMs: undefined,
			sha256: undefined,
		}
	);
}

export function skeletonModel(opts: BenchOptions): ModelIdentity {
	return {
		provider: opts.provider,
		id: opts.model,
		name: "unresolved",
		contextWindow: undefined,
		thinkingLevel: opts.thinking,
	};
}

export function skeletonSettings(opts: BenchOptions, ctx: RunContext): SettingsDiagnostics {
	return {
		agentDir: ctx.agentDir,
		packagesConfigured: [],
		packagesLoaded: [],
		packagesRemoved: [],
		defaultToolsBefore: undefined,
		defaultToolsAfter: undefined,
		codemodeMode: undefined,
		codemodeNote: `codemode=${opts.codemode}`,
		extensionsSetting: undefined,
	};
}

export function skeletonBuild(): StartupSampleReport["build"] {
	return {
		modelRuntimeMs: 0,
		settingsMs: 0,
		loaderMs: 0,
		sessionCreateMs: 0,
		bindExtensionsMs: 0,
		totalMs: 0,
	};
}

function emptyStream(): StartupSampleReport["stream"] {
	return {
		firstMessageUpdateMs: undefined,
		firstThinkingMs: undefined,
		firstTextMs: undefined,
		promptReturnMs: undefined,
		settledMs: undefined,
		wallMs: 0,
	};
}

function emptyDeclared(): StartupSampleReport["declared"] {
	return {
		requestCount: 0,
		firstRequestToolCount: undefined,
		firstRequestToolNames: undefined,
		firstRequestToolsJsonBytes: undefined,
		firstRequestPerTool: undefined,
		firstRequestSystemChars: undefined,
		firstRequestPayloadHash: undefined,
		lastRequestToolCount: undefined,
		requests: [],
	};
}

export function makeFailedStartup(
	ctx: RunContext,
	index: number,
	startedAtIso: string,
	nonce: string | undefined,
	prompt: string,
	reason: string,
): StartupSampleReport {
	return {
		kind: "startup",
		sample: index,
		valid: false,
		invalidReason: reason,
		startedAtIso,
		target: skeletonTarget(ctx),
		mode: ctx.opts.mode,
		codemode: ctx.opts.codemode,
		cwd: ctx.opts.cwd,
		model: skeletonModel(ctx.opts),
		nonce,
		prompt,
		preflight: undefined,
		readyAtMs: 0,
		build: skeletonBuild(),
		stream: emptyStream(),
		usage: usageBreakdown([]),
		activeTools: [],
		activeToolCount: 0,
		declared: emptyDeclared(),
		systemPromptChars: 0,
		systemPromptSha256: "",
		answerText: undefined,
		extensions: [],
		duplicateTools: [],
		settings: skeletonSettings(ctx.opts, ctx),
		errors: [reason],
	};
}

export function makeFailedDelegate(
	ctx: RunContext,
	index: number,
	startedAtIso: string,
	nonce: string | undefined,
	prompt: string,
	reason: string,
): DelegateSampleReport {
	return {
		kind: "delegate",
		sample: index,
		valid: false,
		invalidReason: reason,
		startedAtIso,
		target: skeletonTarget(ctx),
		mode: ctx.opts.mode,
		codemode: ctx.opts.codemode,
		cwd: ctx.opts.cwd,
		model: skeletonModel(ctx.opts),
		nonce,
		prompt,
		modeCommand: undefined,
		codemodeCommand: undefined,
		routing: {
			sequence: [],
			delegated: false,
			runIds: [],
			toolCalls: 0,
			modelCalls: 0,
			usedAwait: false,
			usedAutoAwait: false,
		},
		readyAtMs: 0,
		build: skeletonBuild(),
		stream: emptyStream(),
		parentUsage: usageBreakdown([]),
		parentFinalContext: undefined,
		parentAnswerText: undefined,
		child: {
			runId: undefined,
			taskId: undefined,
			agent: undefined,
			status: undefined,
			model: undefined,
			provider: undefined,
			thinking: undefined,
			tools: undefined,
			sessionFile: undefined,
			branch: undefined,
			isolation: undefined,
			usage: undefined,
			usageSource: "none",
			toolCalls: undefined,
			modelCalls: undefined,
			finalText: undefined,
			containsBenchOk: undefined,
			startedAt: undefined,
			endedAt: undefined,
		},
		bus: [],
		latency: {
			discoveryMs: undefined,
			dispatchMs: undefined,
			firstChildOutputMs: undefined,
			completionMs: undefined,
			settledMs: undefined,
			wallMs: 0,
		},
		declared: emptyDeclared(),
		systemPromptChars: 0,
		systemPromptSha256: "",
		extensions: [],
		duplicateTools: [],
		settings: skeletonSettings(ctx.opts, ctx),
		errors: [reason],
	};
}

export async function waitForSettle(session: AgentSession, timeoutMs: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			unsubscribe();
			resolve(false);
		}, timeoutMs);
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "agent_settled" || settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(true);
		});
	});
}

export async function waitForBusCompletion(
	notifications: BusNotification[],
	runIds: string[],
	afterMs: number,
	timeoutMs: number,
): Promise<BusNotification | undefined> {
	const terminalKinds = new Set(["completed", "failed", "aborted", "done"]);
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const match = notifications.find((notification) => {
			if (notification.atMs < afterMs) return false;
			if (notification.kind === undefined || !terminalKinds.has(notification.kind)) return false;
			if (runIds.length === 0) return true;
			return notification.runId === undefined || runIds.includes(notification.runId);
		});
		if (match) return match;
		if (performance.now() >= deadline) return undefined;
		await sleep(100);
	}
}

export async function runStartupSample(ctx: RunContext, index: number): Promise<StartupSampleReport> {
	const { opts } = ctx;
	const sampleStart = performance.now();
	const startedAtIso = new Date().toISOString();
	const nonce = opts.coldNonce ? randomBytes(8).toString("hex") : undefined;
	const prompt = nonce ? `[bench-nonce ${nonce}]\n${opts.startupPrompt}` : opts.startupPrompt;

	let built: BuiltSession;
	try {
		built = await buildParentSession({ opts });
	} catch (error) {
		return makeFailedStartup(ctx, index, startedAtIso, nonce, prompt, `session build failed: ${errorMessage(error)}`);
	}

	const session = built.session;
	const probe = new Probe(sampleStart);
	const unsubscribe = session.subscribe((event) => probe.handle(event));
	const bus = captureBusNotifications(built.eventBus, sampleStart);
	const errors: string[] = [];
	try {
		let presentation: Awaited<ReturnType<typeof applyPresentationCommands>>;
		try {
			presentation = await applyPresentationCommands(built, probe, opts, errors);
		} catch (error) {
			return makeFailedStartup(ctx, index, startedAtIso, nonce, prompt, errorMessage(error));
		}
		const activeTools = session.getActiveToolNames().slice().sort();
		const systemPrompt = session.systemPrompt ?? "";
		const readyAtMs = probe.now();
		const preflight: { value: string | undefined } = { value: undefined };
		let thrown: string | undefined;
		probe.promptAtMs = probe.now();
		try {
			await session.prompt(prompt, {
				preflightResult: (disposition) => {
					preflight.value = disposition;
				},
			});
		} catch (error) {
			thrown = errorMessage(error);
		}
		probe.promptReturnMs = probe.now();
		if (thrown) errors.push(`prompt rejected: ${thrown}`);
		if (preflight.value !== "started") errors.push(`prompt preflight=${preflight.value ?? "none"} (expected started)`);
		if (probe.settledAtMs === undefined) {
			const settled = await waitForSettle(session, opts.settleTimeoutMs);
			if (!settled) errors.push(`timeout waiting for agent_settled (${opts.settleTimeoutMs}ms)`);
		}
		errors.push(...probe.errors);
		const usage = usageBreakdown(probe.messages);
		const declared = declaredManifest(built.providerRequests);
		const valid =
			usage.calls === 1 &&
			usage.fullInput > 0 &&
			probe.tools.length === 0 &&
			declared.firstRequestToolCount !== undefined &&
			probe.settledAtMs !== undefined &&
			errors.length === 0 &&
			thrown === undefined &&
			preflight.value === "started";
		return {
			kind: "startup",
			sample: index,
			valid,
			invalidReason: valid ? undefined : errors.join("; ") || "no assistant usage",
			startedAtIso,
			target: skeletonTarget(ctx),
			mode: opts.mode,
			codemode: opts.codemode,
			cwd: opts.cwd,
			model: built.model,
			nonce,
			prompt,
			preflight: preflight.value,
			modeCommand: presentation.modeCommand,
			codemodeCommand: presentation.codemodeCommand,
			readyAtMs,
			build: built.timings,
			stream: {
				firstMessageUpdateMs: probe.firstMessageUpdateMs,
				firstThinkingMs: probe.firstThinkingMs,
				firstTextMs: probe.firstTextMs,
				promptReturnMs: probe.promptReturnMs,
				settledMs: probe.lastSettledAtMs,
				wallMs: probe.now(),
			},
			usage,
			activeTools,
			activeToolCount: activeTools.length,
			declared,
			systemPromptChars: systemPrompt.length,
			systemPromptSha256: sessionPromptHash(systemPrompt),
			answerText: session.getLastAssistantText(),
			extensions: built.extensions,
			duplicateTools: built.duplicateTools,
			settings: built.settings,
			errors,
		};
	} finally {
		unsubscribe();
		bus.unsubscribe();
		built.dispose();
	}
}

function sessionPromptHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

interface CommandRun {
	text: string | undefined;
	available: boolean;
	preflight: string | undefined;
	modelCalls: number;
}

async function invokeCommand(
	session: AgentSession,
	probe: Probe,
	extensions: ExtensionDescription[],
	commandText: string | undefined,
	opts: BenchOptions,
	errors: string[],
): Promise<CommandRun | undefined> {
	if (!commandText) return undefined;
	const name = commandText.trim().split(/\s+/)[0]?.replace(/^\//, "") ?? "";
	const available = name !== "" && commandRegistered(extensions, name);
	if (!available) {
		if (opts.allowMissingModeCommand) {
			errors.push(`command not registered, skipped: ${commandText}`);
			return {
				text: commandText,
				available: false,
				preflight: undefined,
				modelCalls: 0,
			};
		}
		return {
			text: commandText,
			available: false,
			preflight: undefined,
			modelCalls: 0,
		};
	}
	const callsBefore = probe.assistantCalls();
	const preflight: { value: string | undefined } = { value: undefined };
	try {
		await session.prompt(commandText, {
			preflightResult: (disposition) => {
				preflight.value = disposition;
			},
		});
	} catch (error) {
		errors.push(`command rejected (${commandText}): ${errorMessage(error)}`);
	}
	const run: CommandRun = {
		text: commandText,
		available,
		preflight: preflight.value,
		modelCalls: probe.assistantCalls() - callsBefore,
	};
	if (preflight.value !== "handled")
		errors.push(`command preflight=${preflight.value ?? "none"} (expected handled): ${commandText}`);
	return run;
}

export async function applyPresentationCommands(
	built: Pick<BuiltSession, "session" | "extensions">,
	probe: Probe,
	opts: BenchOptions,
	errors: string[],
): Promise<{ modeCommand?: CommandRun; codemodeCommand?: CommandRun }> {
	const execute = async (text: string | undefined): Promise<CommandRun | undefined> => {
		const run = await invokeCommand(built.session, probe, built.extensions, text, opts, errors);
		if (!run) return undefined;
		if (!run.available && !opts.allowMissingModeCommand) {
			throw new Error(`command not registered by target: ${text}`);
		}
		if (run.available && (run.preflight !== "handled" || run.modelCalls !== 0)) {
			throw new Error(`command was not handled without model calls: ${text}`);
		}
		return run;
	};
	return {
		modeCommand: await execute(modeCommandText(opts.modeCommand, opts.mode)),
		codemodeCommand: await execute(
			opts.codemodeCommand.trim() ? opts.codemodeCommand.replaceAll("{state}", opts.codemode) : undefined,
		),
	};
}

export async function runDelegateSample(ctx: RunContext, index: number): Promise<DelegateSampleReport> {
	const { opts } = ctx;
	const sampleStart = performance.now();
	const startedAtIso = new Date().toISOString();
	const nonce = opts.coldNonce ? randomBytes(8).toString("hex") : undefined;
	const prompt = nonce ? `[bench-nonce ${nonce}]\n${opts.delegatePrompt}` : opts.delegatePrompt;

	let built: BuiltSession;
	try {
		built = await buildParentSession({ opts });
	} catch (error) {
		return makeFailedDelegate(ctx, index, startedAtIso, nonce, prompt, `session build failed: ${errorMessage(error)}`);
	}

	const session = built.session;
	const probe = new Probe(sampleStart);
	const unsubscribe = session.subscribe((event) => probe.handle(event));
	const bus = captureBusNotifications(built.eventBus, sampleStart);
	const errors: string[] = [];
	try {
		let presentation: Awaited<ReturnType<typeof applyPresentationCommands>>;
		try {
			presentation = await applyPresentationCommands(built, probe, opts, errors);
		} catch (error) {
			return makeFailedDelegate(ctx, index, startedAtIso, nonce, prompt, errorMessage(error));
		}
		const { modeCommand, codemodeCommand } = presentation;
		const systemPrompt = session.systemPrompt ?? "";
		const readyAtMs = probe.now();
		const delegateStart = probe.now();
		const preflight: { value: string | undefined } = { value: undefined };
		let thrown: string | undefined;
		probe.promptAtMs = probe.now();
		const promptWallAt = Date.now();
		try {
			await session.prompt(prompt, {
				preflightResult: (disposition) => {
					preflight.value = disposition;
				},
			});
		} catch (error) {
			thrown = errorMessage(error);
		}
		probe.promptReturnMs = probe.now();
		if (thrown) errors.push(`delegate prompt rejected: ${thrown}`);
		else if (preflight.value !== "started")
			errors.push(`delegate preflight=${preflight.value ?? "none"} (expected started)`);

		const delegateTools = probe.tools.filter((tool) => tool.startMs >= delegateStart);
		const runs = collectRuns(delegateTools);
		const delegated = runs.length > 0 || delegateTools.some((tool) => tool.toolName === "subagent");
		const sequence = routingSequence(delegateTools);
		if (!delegated) {
			errors.push(
				`no subagent delegation observed (tools: ${sequence.map((entry) => entry.tool).join(", ") || "none"})`,
			);
		}
		const subagentTool = delegateTools.find((tool) => tool.toolName === "subagent");
		if (!matchesControlledArguments(subagentTool?.argsPreview, controlledArguments(opts))) {
			errors.push("parent changed controlled child arguments or nested spawn arguments were not captured");
		}
		const discoveryMs = subagentTool ? subagentTool.startMs - delegateStart : undefined;
		const dispatchMs = subagentTool?.endMs !== undefined ? subagentTool.endMs - subagentTool.startMs : undefined;
		const runIds = runs.map((run) => run.id);

		const completion = delegated
			? await waitForBusCompletion(bus.notifications, runIds, delegateStart, opts.childTimeoutMs)
			: undefined;
		const completionMs = completion?.atMs;
		if (delegated && !completion) {
			errors.push(`timeout waiting for child completion notification (${opts.childTimeoutMs}ms)`);
		}

		let settledMs = probe.lastSettledAtMs;
		if (settledMs === undefined || (completionMs !== undefined && settledMs < completionMs)) {
			const settled = await waitForSettle(session, opts.settleTimeoutMs);
			settledMs = probe.lastSettledAtMs;
			if (!settled) errors.push(`timeout waiting for final agent_settled (${opts.settleTimeoutMs}ms)`);
		}

		const childRun = pickRunSnapshot(delegateTools, completion?.runId);
		const task = childRun?.tasks.find((candidate) => candidate.status === "completed") ?? childRun?.tasks[0];
		let sessionFile = task?.sessionFile;
		let parsed = sessionFile ? parseChildSessionFile(sessionFile) : undefined;
		if (!parsed) {
			const found = findChildSession(ctx.agentDir, promptWallAt - 2000);
			if (found) {
				sessionFile = found.sessionFile;
				parsed = found.metrics;
			}
		}
		if ((task?.model ?? parsed?.model) !== opts.model || (task?.provider ?? parsed?.provider) !== opts.provider) {
			errors.push("child model/provider differs from the controlled parent model");
		}
		if ((task?.thinking ?? parsed?.thinkingLevel) !== opts.thinking) {
			errors.push("child thinking differs from the controlled parent thinking");
		}
		const snapshotUsage = task?.usage;
		const snapshotNonZero =
			snapshotUsage !== undefined &&
			snapshotUsage.input +
				snapshotUsage.output +
				snapshotUsage.cacheRead +
				snapshotUsage.cacheWrite +
				snapshotUsage.totalTokens >
				0;
		const childUsage = snapshotNonZero
			? snapshotUsage
			: parsed && parsed.assistantMessages > 0
				? parsed.usage
				: undefined;
		const usageSource: DelegateSampleReport["child"]["usageSource"] = snapshotNonZero
			? "run-snapshot"
			: parsed && parsed.assistantMessages > 0
				? "session-file"
				: "none";
		const containsBenchOk = (task?.finalText ?? parsed?.finalText)?.trim() === "BENCH_OK";
		if (delegated && usageSource === "none")
			errors.push("child usage unavailable (no run snapshot, no persisted child session found)");
		if (delegated && containsBenchOk !== true) errors.push("child BENCH_OK not observed");
		const childToolCalls = task?.toolCalls ?? parsed?.toolCallCount;
		if (delegated && childToolCalls !== undefined && childToolCalls > 0)
			errors.push(`controlled child used ${childToolCalls} tool call(s); benchmark requires 0`);
		if (delegated && childToolCalls === undefined) errors.push("child tool-call count unknown");
		if (delegated && task?.branch) errors.push(`child ran on branch ${task.branch}; benchmark requires no worktree`);

		const parentUsage = usageBreakdown(probe.messages.filter((message) => message.atMs >= delegateStart));
		const lastAssistant = probe.messages
			.filter((message) => message.role === "assistant" && message.atMs >= delegateStart)
			.at(-1);
		const parentFinalContext = lastAssistant?.usage
			? {
					input: lastAssistant.usage.input,
					cacheRead: lastAssistant.usage.cacheRead,
					cacheWrite: lastAssistant.usage.cacheWrite,
					fullInput: lastAssistant.usage.input + lastAssistant.usage.cacheRead + lastAssistant.usage.cacheWrite,
				}
			: undefined;
		const routingModelCalls = probe.messages.filter(
			(message) => message.role === "assistant" && message.atMs >= delegateStart,
		).length;
		const valid =
			delegated &&
			errors.length === 0 &&
			preflight.value === "started" &&
			completion !== undefined &&
			settledMs !== undefined &&
			thrown === undefined &&
			usageSource !== "none" &&
			containsBenchOk === true &&
			childRun?.tasks.length === 1 &&
			task?.status === "completed" &&
			childToolCalls === 0 &&
			!task?.branch;
		if (!valid && errors.length === 0) errors.push("delegation did not meet the BENCH_OK/completed criteria");

		return {
			kind: "delegate",
			sample: index,
			valid,
			invalidReason: valid ? undefined : errors.join("; "),
			startedAtIso,
			target: skeletonTarget(ctx),
			mode: opts.mode,
			codemode: opts.codemode,
			cwd: opts.cwd,
			model: built.model,
			nonce,
			prompt,
			modeCommand,
			codemodeCommand,
			routing: {
				sequence,
				delegated,
				runIds,
				toolCalls: delegateTools.length,
				modelCalls: routingModelCalls,
				usedAwait: sequence.some((entry) => entry.tool === "await_subagent"),
				usedAutoAwait: argsFlag(subagentTool?.argsPreview, "autoAwait"),
			},
			readyAtMs,
			build: built.timings,
			stream: {
				firstMessageUpdateMs: probe.firstMessageUpdateMs,
				firstThinkingMs: probe.firstThinkingMs,
				firstTextMs: probe.firstTextMs,
				promptReturnMs: probe.promptReturnMs,
				settledMs,
				wallMs: probe.now(),
			},
			parentUsage,
			parentFinalContext,
			parentAnswerText: session.getLastAssistantText(),
			child: {
				runId: childRun?.id ?? completion?.runId,
				taskId: task?.id,
				agent: task?.agent,
				status: task?.status ?? childRun?.status,
				model: task?.model ?? parsed?.model,
				provider: task?.provider ?? parsed?.provider,
				thinking: task?.thinking ?? parsed?.thinkingLevel,
				tools: task?.tools,
				sessionFile,
				branch: task?.branch,
				isolation: task?.isolation,
				usage: childUsage,
				usageSource,
				toolCalls: childToolCalls,
				modelCalls:
					snapshotUsage?.turns !== undefined && snapshotUsage.turns > 0
						? snapshotUsage.turns
						: parsed?.assistantMessages,
				finalText: task?.finalText ?? parsed?.finalText,
				containsBenchOk,
				startedAt: task?.startedAt,
				endedAt: task?.endedAt,
			},
			bus: bus.notifications,
			latency: {
				discoveryMs,
				dispatchMs,
				firstChildOutputMs: parsed?.firstAssistantAt !== undefined ? parsed.firstAssistantAt - promptWallAt : undefined,
				completionMs,
				settledMs,
				wallMs: probe.now(),
			},
			declared: declaredManifest(built.providerRequests),
			systemPromptChars: systemPrompt.length,
			systemPromptSha256: sessionPromptHash(systemPrompt),
			extensions: built.extensions,
			duplicateTools: built.duplicateTools,
			settings: built.settings,
			errors,
		};
	} finally {
		unsubscribe();
		bus.unsubscribe();
		built.dispose();
	}
}
