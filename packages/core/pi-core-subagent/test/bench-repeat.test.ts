import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type BenchOptions, resolveOptions } from "../bench/lib/args.ts";
import { controlledArguments } from "../bench/lib/contract.ts";
import { addUsage, emptyUsage, Probe, type UsageCounts, usageFromUnknown } from "../bench/lib/probe.ts";
import {
	buildRepeatSummary,
	computeIntegrity,
	dedupeNotifications,
	fullInputOf,
	makeSyntheticRepeatDriver,
	promptEmbedsControlledArguments,
	recordRepeatEvent,
	repeatPrompt,
	runRepeatedDelegations,
	runRepeatSession,
	type SyntheticIteration,
} from "../bench/lib/repeat.ts";

function baseOpts(extra: string[] = []): BenchOptions {
	const opts = resolveOptions(["--dry-run", ...extra]);
	if (!opts) throw new Error("benchmark test options unavailable");
	return opts;
}

async function runScript(script: SyntheticIteration[], turns = script.length, opts = baseOpts()) {
	const handle = makeSyntheticRepeatDriver(opts, script);
	const result = await runRepeatedDelegations(handle.driver, opts, turns, 0);
	return { ...result, handle };
}

describe("repeat prompt contract", () => {
	test("each iteration is numbered but the embedded child arguments are byte-identical", () => {
		const opts = baseOpts();
		const args = JSON.stringify(controlledArguments(opts));
		const prompts = [1, 2, 3, 4, 5].map((iteration) => repeatPrompt(opts, iteration));
		for (const [index, prompt] of prompts.entries()) {
			expect(prompt).toContain(`delegation ${index + 1}`);
			expect(prompt.split("\n")[0]).toContain("do not reuse the previous result");
			expect(prompt).toContain(args);
			expect(prompt.split(args)).toHaveLength(2);
		}
		expect(promptEmbedsControlledArguments(opts)).toBe(true);
	});

	test("a delegate prompt without the controlled arguments is rejected before live runs", () => {
		const overridden = baseOpts(["--delegate-prompt", "delegate something"]);
		expect(promptEmbedsControlledArguments(baseOpts())).toBe(true);
		expect(promptEmbedsControlledArguments(overridden)).toBe(false);
	});
});

describe("repeated delegation correlation", () => {
	test("five successive delegations reuse one session and correlate exact new run ids", async () => {
		const script: SyntheticIteration[] = Array.from({ length: 5 }, (_, index) => ({
			runId: `run_${index + 1}`,
			parentInput: 100 + index * 10,
			parentCacheRead: index,
			parentCacheWrite: index % 2,
			childInput: 40,
			childOutput: 4,
			childCost: 0.00002,
		}));
		const { iterations, handle, abortedAfter } = await runScript(script, 5);
		expect(iterations.map((iteration) => iteration.valid)).toEqual([true, true, true, true, true]);
		expect(abortedAfter).toBeUndefined();
		expect(iterations.map((iteration) => iteration.runId)).toEqual(["run_1", "run_2", "run_3", "run_4", "run_5"]);
		expect(iterations.map((iteration) => iteration.newRun)).toEqual([true, true, true, true, true]);
		expect(handle.dispatchedPrompts).toHaveLength(5);
		expect(handle.dispatchedPrompts[0]).toContain("delegation 1");
		expect(handle.dispatchedPrompts[4]).toContain("delegation 5");
		expect(handle.emittedRunIds).toEqual(["run_1", "run_2", "run_3", "run_4", "run_5"]);
		for (const [index, iteration] of iterations.entries()) {
			expect(iteration.parent.usage.input).toBe((100 + index * 10) * 2);
			expect(iteration.parent.usage.cacheRead).toBe(index * 2);
			expect(iteration.parent.usage.cacheWrite).toBe((index % 2) * 2);
			expect(iteration.child.usage?.input).toBe(40);
			expect(iteration.child.modelCalls).toBe(1);
			expect(iteration.parent.providerRequests).toBe(2);
		}
	});

	test("a repeated BENCH_OK with no new run invalidates and aborts the session loop", async () => {
		const { iterations, handle, abortedAfter } = await runScript([
			{ runId: "run_1" },
			{ noNewRun: true, parentFinalText: "BENCH_OK" },
			{ runId: "run_3" },
		]);
		expect(iterations).toHaveLength(2);
		expect(abortedAfter).toBe(2);
		expect(handle.dispatchedPrompts).toHaveLength(2);
		expect(iterations[0]?.valid).toBe(true);
		expect(iterations[1]?.valid).toBe(false);
		expect(iterations[1]?.invalidReason).toContain("no new run");
		expect(iterations[1]?.reusedPriorRun).toBe(true);
		expect(iterations[1]?.runId).toBeUndefined();
	});

	test("a completion notification for another run cannot satisfy the iteration", async () => {
		const opts = baseOpts();
		const handle = makeSyntheticRepeatDriver(opts, [{ runId: "run_1" }]);
		const originalWait = handle.driver.waitBusCompletion.bind(handle.driver);
		handle.driver.waitBusCompletion = (runIds, afterMs, timeoutMs) =>
			originalWait(runIds, afterMs, timeoutMs).then(() => {
				const notification = handle.driver.bus.find((event) => event.runId === "run_1");
				return notification ? { ...notification, runId: "run_stale" } : undefined;
			});
		const { iterations } = await runRepeatedDelegations(handle.driver, opts, 1, 0);
		expect(iterations[0]?.valid).toBe(false);
		expect(iterations[0]?.invalidReason).toContain("expected run_1");
	});

	test("multiple new runs or duplicate run snapshots never get summed twice", async () => {
		const { iterations } = await runScript([{ runId: "run_1", extraRunIds: ["run_extra"] }]);
		expect(iterations[0]?.valid).toBe(false);
		expect(iterations[0]?.invalidReason).toContain("multiple new runs");
		expect(iterations[0]?.runIds).toEqual(["run_1", "run_extra"]);
	});

	test("child shape violations are explicit invalid reasons", async () => {
		const cases: Array<{ step: SyntheticIteration; reason: string }> = [
			{ step: { runId: "run_1", childToolCalls: 1 }, reason: "tool call" },
			{ step: { runId: "run_2", childModelCalls: 2 }, reason: "model calls" },
			{ step: { runId: "run_3", childFinalText: "PONG" }, reason: "BENCH_OK" },
			{ step: { runId: "run_4", branch: "bench/worktree" }, reason: "worktree" },
		];
		for (const entry of cases) {
			const { iterations } = await runScript([entry.step]);
			expect(iterations[0]?.valid).toBe(false);
			expect(iterations[0]?.invalidReason).toContain(entry.reason);
		}
	});

	test("delayed follow-ups settle inside the iteration that caused them", async () => {
		const { iterations } = await runScript([
			{ runId: "run_1", parentInput: 100, delayedFollowUp: true },
			{ runId: "run_2", parentInput: 200 },
		]);
		expect(iterations[0]?.valid).toBe(true);
		expect(iterations[1]?.valid).toBe(true);
		expect(iterations[0]?.parent.usage.input).toBe(207);
		expect(iterations[1]?.parent.usage.input).toBe(400);
		expect(iterations[1]?.parent.usage.cacheRead).toBe(0);
	});
});

describe("repeat validity regressions", () => {
	test("completion and final settlement use the current prompt boundary", async () => {
		const opts = baseOpts();
		const handle = makeSyntheticRepeatDriver(opts, [{ runId: "run_1" }, { runId: "run_2" }]);
		const originalIdle = handle.driver.waitIdle;
		handle.driver.waitIdle = async (...args) => {
			const idle = await originalIdle(...args);
			handle.driver.probe.lastSettledAtMs = handle.driver.probe.now() + 10;
			return idle;
		};
		const { iterations } = await runRepeatedDelegations(handle.driver, opts, 2, 0);
		for (const iteration of iterations) {
			const notice = iteration.bus.find((event) => event.runId === iteration.runId);
			expect(iteration.latency.completionMs).toBeCloseTo((notice?.atMs ?? 0) - iteration.promptAtMs, 8);
			expect(iteration.wallMs).toBeGreaterThanOrEqual(10);
		}
	});

	test("errors, missing usage, retries and unavailable costs cannot count as success", async () => {
		for (const kind of ["error", "usage", "retry", "cost", "tool"] as const) {
			const opts = baseOpts();
			const handle = makeSyntheticRepeatDriver(opts, [{ runId: "run_1" }]);
			const original = handle.driver.dispatch;
			handle.driver.dispatch = async (prompt) => {
				const result = await original(prompt);
				if (kind === "error") handle.driver.probe.errors.push("provider failed before recovery");
				if (kind === "usage") handle.driver.probe.messages[0]!.usage = undefined;
				if (kind === "cost") handle.driver.probe.messages[0]!.usage!.cost = Number.NaN;
				if (kind === "tool") handle.driver.probe.tools[0]!.isError = true;
				return result;
			};
			if (kind === "retry") {
				const count = handle.driver.providerRequestCount;
				handle.driver.providerRequestCount = () => count() + (handle.dispatchedPrompts.length ? 2 : 0);
			}
			const { iterations } = await runRepeatedDelegations(handle.driver, opts, 1, 0);
			expect(iterations[0]?.valid, kind).toBe(false);
			if (kind === "cost") expect(iterations[0]?.parent.costEstimate).toBeUndefined();
		}
	});

	test("raw missing costs remain unavailable while explicit zero is valid", () => {
		for (const cost of [undefined, 0]) {
			const probe = new Probe(performance.now());
			recordRepeatEvent(probe, {
				type: "message_end",
				message: { role: "assistant", content: [], usage: { input: 1, output: 1, cost } },
			} as unknown as AgentSessionEvent);
			expect(probe.errors.length).toBe(cost === undefined ? 1 : 0);
		}
	});

	test("a notification without a correlated run id is not completion evidence", async () => {
		const opts = baseOpts();
		const handle = makeSyntheticRepeatDriver(opts, [{ runId: "run_1" }]);
		const original = handle.driver.waitBusCompletion;
		handle.driver.waitBusCompletion = async (...args) => {
			const notice = await original(...args);
			return notice ? { ...notice, runId: undefined } : undefined;
		};
		const { iterations } = await runRepeatedDelegations(handle.driver, opts, 1, 0);
		expect(iterations[0]?.valid).toBe(false);
	});
});

describe("repeat accounting", () => {
	test("fullInput includes cacheWrite and per-iteration sums equal whole-session usage", async () => {
		const opts = baseOpts();
		const script: SyntheticIteration[] = [
			{ runId: "run_1", parentInput: 10, parentCacheRead: 2, parentCacheWrite: 3, parentOutput: 4, parentCost: 0.001 },
			{ runId: "run_2", parentInput: 20, parentCacheRead: 5, parentCacheWrite: 7, parentOutput: 6, parentCost: 0.002 },
		];
		const { driver } = makeSyntheticRepeatDriver(opts, script);
		const { iterations } = await runRepeatedDelegations(driver, opts, 2, 0);
		const allocated = emptyUsage();
		for (const iteration of iterations) addUsage(allocated, iteration.parent.usage);
		const sessionUsage = usageFromUnknown({
			input: 60,
			output: 40,
			cacheRead: 14,
			cacheWrite: 20,
			cost: { total: 0.006 },
		});
		const integrity = computeIntegrity({
			sessionParent: sessionUsage,
			allocatedParent: allocated,
			providerRequestsTotal: 2,
			allocatedProviderRequests: 2,
			modelCallsTotal: 4,
			allocatedModelCalls: 4,
		});
		expect(integrity.ok).toBe(true);
		expect(integrity.unattributedParent.input).toBe(0);
		expect(fullInputOf(allocated)).toBe(60 + 14 + 20);
	});

	test("allocated usage above the session total is rejected, zero usage is clean", () => {
		const zero = emptyUsage();
		const clean = computeIntegrity({
			sessionParent: zero,
			allocatedParent: zero,
			providerRequestsTotal: 0,
			allocatedProviderRequests: 0,
			modelCallsTotal: 0,
			allocatedModelCalls: 0,
		});
		expect(clean.ok).toBe(true);
		const allocated = emptyUsage();
		allocated.input = 5;
		allocated.cost = 0.01;
		const doubled = computeIntegrity({
			sessionParent: zero,
			allocatedParent: allocated,
			providerRequestsTotal: 0,
			allocatedProviderRequests: 1,
			modelCallsTotal: 0,
			allocatedModelCalls: 1,
		});
		expect(doubled.ok).toBe(false);
		expect(doubled.notes.join(" ")).toContain("exceeds session total");
	});

	test("notification payload duplicates count once", () => {
		const notification = { atMs: 1, runId: "run_1", taskId: "task_1", kind: "completed", body: "done" };
		const deduped = dedupeNotifications([
			notification,
			{ ...notification, atMs: 9 },
			{ ...notification, runId: "run_2" },
		]);
		expect(deduped).toHaveLength(2);
		expect(dedupeNotifications([])).toEqual([]);
	});
});

describe("repeat summary clustering", () => {
	test("first, later and cumulative epochs keep per-session values", async () => {
		const opts = baseOpts();
		const sessionA = await runScript(
			[
				{ runId: "a1", parentInput: 10, parentCost: 0.001 },
				{ runId: "a2", parentInput: 20, parentCost: 0.002 },
				{ runId: "a3", parentInput: 30, parentCost: 0.003 },
			],
			3,
			opts,
		);
		const sessionB = await runScript(
			[
				{ runId: "b1", parentInput: 100, parentCost: 0.01 },
				{ runId: "b2", parentInput: 200, parentCost: 0.02 },
				{ runId: "b3", parentInput: 300, parentCost: 0.03 },
			],
			3,
			opts,
		);
		const summary = buildRepeatSummary([
			{ iterations: sessionA.iterations, setupMs: 100 },
			{ iterations: sessionB.iterations, setupMs: 200 },
		]);
		expect(summary.sessions).toBe(2);
		expect(summary.turns).toBe(3);
		expect(summary.validIterations).toBe(6);
		expect(summary.setupMs.distribution?.mean).toBe(150);
		const input = summary.metrics.find((metric) => metric.metric === "parentUncachedInput");
		expect(input?.first.bySession).toEqual([20, 200]);
		expect(input?.later.bySession).toEqual([50, 500]);
		expect(input?.later.sessionDistribution?.mean).toBe(275);
		expect(input?.cumulative.bySession).toEqual([120, 1200]);
		expect(input?.positions.map((stat) => stat.sessionDistribution?.mean)).toEqual([110, 220, 330]);
		expect(input?.later.pooled).toEqual([40, 60, 400, 600]);
	});

	test("invalid iterations are excluded from epochs but stay visible", async () => {
		const { iterations } = await runScript([
			{ runId: "run_1", parentInput: 10 },
			{ noNewRun: true, parentInput: 20 },
			{ runId: "run_3", parentInput: 30 },
		]);
		const summary = buildRepeatSummary([{ iterations, setupMs: 1 }]);
		expect(summary.totalIterations).toBe(2);
		expect(summary.validIterations).toBe(1);
		const input = summary.metrics.find((metric) => metric.metric === "parentUncachedInput");
		expect(input?.later.bySession[0]).toBeUndefined();
		expect(input?.cumulative.bySession[0]).toBe(20);
	});
});

describe("repeat session boundaries", () => {
	test("a failed session build returns a report instead of throwing", async () => {
		const opts = baseOpts(["--model", "no-such-model-for-repeat-bench"]);
		const report = await runRepeatSession({
			ctx: { opts, target: undefined, agentDir: getAgentDir() },
			sessionIndex: 1,
			turns: 3,
		});
		expect(report.valid).toBe(false);
		expect(report.iterations).toEqual([]);
		expect(report.invalidReason).toContain("session build failed");
	});

	test("custom usage types keep turns and cost estimates intact", () => {
		const usage: UsageCounts = usageFromUnknown({
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { total: 0.5 },
			turns: 1,
		});
		expect(usage.cacheWrite).toBe(4);
		expect(usage.cost).toBe(0.5);
		expect(usage.turns).toBe(1);
	});
});
