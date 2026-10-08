import { performance } from "node:perf_hooks";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type BenchOptions, resolveOptions } from "./args.ts";
import { controlledArguments } from "./contract.ts";
import { type BenchRunSnapshot, type BusNotification, emptyUsage, Probe } from "./probe.ts";
import {
	computeIntegrity,
	dedupeNotifications,
	promptEmbedsControlledArguments,
	type RepeatDriver,
	repeatPrompt,
	runRepeatedDelegations,
} from "./repeat.ts";
import { buildRepeatSummary } from "./repeat-summary.ts";
import { waitForBusCompletion } from "./samples.ts";
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
