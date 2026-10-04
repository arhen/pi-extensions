import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { resolveOptions } from "./args.ts";
import {
	argsFlag,
	Probe,
	parseChildSessionFile,
	pickRunSnapshot,
	routingSequence,
	type ToolRecord,
	usageFromUnknown,
} from "./probe.ts";
import {
	type BenchReport,
	buildSummary,
	distribution,
	type SampleReport,
	SCHEMA,
	writeRawSamples,
	writeReport,
} from "./report.ts";
import {
	makeFailedDelegate,
	makeFailedStartup,
	type RunContext,
} from "./samples.ts";
import { isSubagentPackage, modeCommandText, planCodemode } from "./session.ts";

class Checks {
	count = 0;
	run(label: string, fn: () => void): void {
		this.count += 1;
		try {
			fn();
		} catch (error) {
			throw new Error(
				`self-test failed: ${label}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	if (actual !== expected)
		throw new Error(
			`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
}

const event = (value: unknown): AgentSessionEvent => value as AgentSessionEvent;

function probeSelfTest(checks: Checks): void {
	checks.run("probe timings/usage/cache state", () => {
		const probe = new Probe(performance.now());
		probe.handle(event({ type: "agent_start" }));
		probe.handle(
			event({
				type: "message_update",
				message: {},
				assistantMessageEvent: { type: "thinking_delta", delta: "t" },
			}),
		);
		probe.handle(
			event({
				type: "message_update",
				message: {},
				assistantMessageEvent: { type: "text_delta", delta: "b" },
			}),
		);
		probe.handle(
			event({
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "BENCH_OK" }],
					usage: {
						input: 100,
						output: 20,
						cacheRead: 0,
						cacheWrite: 120,
						reasoning: 10,
						totalTokens: 240,
						cost: { total: 0.001 },
					},
				},
			}),
		);
		probe.handle(event({ type: "agent_settled" }));
		probe.handle(event({ type: "agent_settled" }));
		assert(probe.firstThinkingMs !== undefined, "firstThinkingMs recorded");
		assert(probe.firstTextMs !== undefined, "firstTextMs recorded");
		assert(
			(probe.firstThinkingMs ?? 0) <= (probe.firstTextMs ?? 0),
			"thinking delta precedes text delta",
		);
		assertEqual(probe.assistantCalls(), 1, "assistant calls");
		assertEqual(probe.settledCount, 2, "settle count");
		assert(
			probe.lastSettledAtMs !== undefined,
			"last settle timestamp recorded",
		);
		const usage = usageFromUnknown({
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 3,
			totalTokens: 18,
			cost: { total: 0.5 },
		});
		assertEqual(usage.cacheWrite, 3, "cacheWrite");
		assertEqual(usage.cost, 0.5, "cost");
	});
	checks.run("distribution", () => {
		const dist = distribution([10, 20, 30]);
		assert(dist !== undefined, "distribution exists");
		assertEqual(dist?.n, 3, "n");
		assertEqual(dist?.median, 20, "median");
		assertEqual(dist?.min, 10, "min");
		assertEqual(dist?.max, 30, "max");
		assert(
			dist !== undefined && dist.stdev > 8 && dist.stdev < 9,
			"stdev in range",
		);
		assertEqual(distribution([]), undefined, "empty distribution");
	});
	checks.run("routing and run snapshot picking", () => {
		const tools: ToolRecord[] = [
			{
				toolCallId: "1",
				toolName: "subagent",
				startMs: 100,
				endMs: 150,
				isError: false,
				argsPreview: '{"autoAwait":true}',
				resultText: "started",
				run: {
					id: "run_1",
					mode: "single",
					status: "running",
					createdAt: 1,
					startedAt: 2,
					endedAt: undefined,
					tasks: [],
				},
				updates: 0,
			},
			{
				toolCallId: "2",
				toolName: "subagent_status",
				startMs: 200,
				endMs: 210,
				isError: false,
				argsPreview: "{}",
				resultText: "status",
				run: {
					id: "run_1",
					mode: "single",
					status: "completed",
					createdAt: 1,
					startedAt: 2,
					endedAt: 999,
					tasks: [],
				},
				updates: 0,
			},
		];
		const picked = pickRunSnapshot(tools);
		assertEqual(picked?.status, "completed", "terminal snapshot preferred");
		const sequence = routingSequence(tools);
		assertEqual(sequence.length, 2, "routing sequence length");
		assertEqual(sequence[0]?.tool, "subagent", "routing first tool");
		assertEqual(
			argsFlag(sequence[0]?.argsPreview, "autoAwait"),
			true,
			"autoAwait flag detected",
		);
		assertEqual(
			argsFlag('{\n  "autoAwait": true\n}', "autoAwait"),
			true,
			"pretty-printed autoAwait detected",
		);
		assertEqual(
			argsFlag('{"tasks":[]}', "autoAwait"),
			false,
			"absent autoAwait ignored",
		);
	});
}

function childSessionSelfTest(checks: Checks, dir: string): void {
	checks.run("child session jsonl parsing", () => {
		const file = join(dir, "child.jsonl");
		const lines = [
			{
				type: "session",
				version: 3,
				id: "child-1",
				timestamp: "2026-10-04T10:00:00.000Z",
				cwd: "/tmp",
			},
			{
				type: "model_change",
				id: "e1",
				parentId: null,
				timestamp: "2026-10-04T10:00:00.010Z",
				provider: "opencode-go",
				modelId: "deepseek-v4.1-flash",
			},
			{
				type: "thinking_level_change",
				id: "e2",
				parentId: "e1",
				timestamp: "2026-10-04T10:00:00.011Z",
				thinkingLevel: "max",
			},
			{
				type: "message",
				id: "e3",
				parentId: "e2",
				timestamp: "2026-10-04T10:00:00.100Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "Reply with exactly BENCH_OK" }],
				},
			},
			{
				type: "message",
				id: "e4",
				parentId: "e3",
				timestamp: "2026-10-04T10:00:01.500Z",
				message: {
					role: "assistant",
					model: "deepseek-v4.1-flash",
					provider: "opencode-go",
					stopReason: "stop",
					content: [{ type: "text", text: "BENCH_OK" }],
					usage: {
						input: 300,
						output: 5,
						cacheRead: 0,
						cacheWrite: 350,
						reasoning: 2,
						totalTokens: 655,
						cost: { total: 0.0002 },
					},
				},
			},
		];
		writeFileSync(
			file,
			`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
		);
		const metrics = parseChildSessionFile(file);
		assert(metrics !== null, "child metrics parsed");
		assertEqual(metrics?.containsBenchOk, true, "BENCH_OK detected");
		assertEqual(metrics?.assistantMessages, 1, "assistant message count");
		assertEqual(metrics?.toolCallCount, 0, "no child tool calls");
		assertEqual(metrics?.usage.input, 300, "child uncached input");
		assertEqual(metrics?.model, "deepseek-v4.1-flash", "child model");
		assertEqual(metrics?.provider, "opencode-go", "child provider");
		assertEqual(metrics?.thinkingLevel, "max", "child thinking level");
		assertEqual(
			metrics?.firstUserAt !== undefined &&
				metrics?.firstAssistantAt !== undefined &&
				metrics.firstAssistantAt > metrics.firstUserAt,
			true,
			"child ordering",
		);
	});
	checks.run("missing child session returns null", () => {
		assertEqual(
			parseChildSessionFile(join(dir, "nope.jsonl")),
			null,
			"missing file",
		);
	});
}

function codemodePlanSelfTest(checks: Checks): void {
	checks.run("codemode plan states", () => {
		const disabled = planCodemode("disabled", ["+codemode", "read"]);
		assertEqual(disabled.factory, undefined, "disabled factory omitted");
		assertEqual(
			JSON.stringify(disabled.defaultTools),
			JSON.stringify(["read"]),
			"disabled removes codemode",
		);
		assertEqual(
			planCodemode("disabled", undefined).defaultTools,
			undefined,
			"disabled leaves undefined defaultTools alone",
		);
		const active = planCodemode("active", ["+codemode"]);
		assert(active.factory !== undefined, "active factory present");
		assertEqual(active.modeOverride, undefined, "active leaves mode untouched");
		assertEqual(
			JSON.stringify(active.defaultTools),
			JSON.stringify(["+codemode"]),
			"active leaves defaultTools",
		);
		assertEqual(
			JSON.stringify(planCodemode("active", undefined).defaultTools),
			JSON.stringify(["+codemode"]),
			"active enables codemode when defaultTools unset",
		);
		const only = planCodemode("only", ["+codemode"]);
		assertEqual(only.modeOverride, "only", "only mode override");
		assert(only.factory !== undefined, "only factory present");
		const enabled = planCodemode("on", undefined);
		assertEqual(
			JSON.stringify(enabled.defaultTools),
			JSON.stringify(["+codemode"]),
			"on adds codemode when defaultTools unset",
		);
	});
	checks.run("package filtering + mode command text", () => {
		assertEqual(
			isSubagentPackage("npm:@arhen/pi-core-subagent"),
			true,
			"string package match",
		);
		assertEqual(
			isSubagentPackage({ source: "npm:@arhen/pi-core-subagent" }),
			true,
			"object package match",
		);
		assertEqual(
			isSubagentPackage("npm:@arhen/pi-core-todo"),
			false,
			"other package kept",
		);
		assertEqual(
			modeCommandText("/subagents mode {mode}", "baseline"),
			undefined,
			"baseline never invokes command",
		);
		assertEqual(
			modeCommandText("/subagents mode {mode}", "codemode"),
			"/subagents mode codemode",
			"mode template substitution",
		);
	});
}

function reportSelfTest(checks: Checks, dir: string): void {
	const opts = resolveOptions(["--self-test"]);
	if (!opts) throw new Error("self-test options did not resolve");
	const ctx: RunContext = {
		opts,
		target: undefined,
		agentDir: join(dir, "agent"),
	};
	const startup = (
		sample: number,
		mode: "baseline" | "direct",
		setupMs: number,
		fullInput: number,
		cacheRead: number,
	): SampleReport => {
		const base = makeFailedStartup(
			ctx,
			sample,
			new Date().toISOString(),
			undefined,
			"hi",
			"",
		);
		return {
			...base,
			mode,
			valid: true,
			invalidReason: undefined,
			build: { ...base.build, totalMs: setupMs },
			usage: {
				...base.usage,
				calls: 1,
				uncachedInput: fullInput - cacheRead,
				fullInput,
				total: {
					...base.usage.total,
					input: fullInput - cacheRead,
					cacheRead,
					output: 10,
					cacheWrite: cacheRead,
					totalTokens: fullInput + 10,
				},
			},
			declared: {
				...base.declared,
				firstRequestToolCount: mode === "baseline" ? 24 : 22,
			},
			stream: { ...base.stream, firstTextMs: 1000, settledMs: 1500 },
			errors: [],
		};
	};
	const delegate = (
		sample: number,
		mode: "baseline" | "direct",
		completionMs: number,
		parentInput: number,
		childInput: number,
	): SampleReport => {
		const base = makeFailedDelegate(
			ctx,
			sample,
			new Date().toISOString(),
			undefined,
			"delegate",
			"",
		);
		return {
			...base,
			mode,
			valid: true,
			invalidReason: undefined,
			routing: {
				...base.routing,
				delegated: true,
				sequence: [
					{
						tool: "subagent",
						atMs: 500,
						endMs: 600,
						isError: false,
						argsPreview: '{"agent":"bench","autoAwait":true}',
					},
				],
				toolCalls: 1,
				modelCalls: 2,
			},
			latency: {
				...base.latency,
				discoveryMs: 500,
				dispatchMs: 100,
				firstChildOutputMs: 1500,
				completionMs,
				settledMs: completionMs + 200,
			},
			child: {
				...base.child,
				usageSource: "run-snapshot",
				containsBenchOk: true,
				status: "completed",
				modelCalls: 1,
				usage: {
					input: childInput,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					reasoning: undefined,
					totalTokens: childInput + 5,
					cost: 0,
					turns: 1,
				},
			},
			parentUsage: {
				...base.parentUsage,
				calls: 2,
				uncachedInput: parentInput,
				fullInput: parentInput,
				total: {
					...base.parentUsage.total,
					input: parentInput,
					output: 40,
					totalTokens: parentInput + 40,
				},
			},
			errors: [],
		};
	};
	checks.run("summary distributions and comparison", () => {
		const samples: SampleReport[] = [
			startup(1, "baseline", 500, 20_000, 0),
			startup(2, "baseline", 520, 20_100, 0),
			startup(3, "direct", 480, 18_000, 0),
			delegate(1, "baseline", 9_000, 30_000, 12_000),
			delegate(2, "direct", 8_500, 26_000, 11_000),
		];
		const summary = buildSummary(samples);
		assertEqual(summary.startup?.validSamples, 3, "startup valid samples");
		assertEqual(
			summary.startup?.distributions.setupTotalMs?.median,
			500,
			"startup setup median",
		);
		assertEqual(
			summary.delegate?.distributions.completionMs?.median,
			8_750,
			"delegate completion median",
		);
		const fullInput = summary.comparison.find(
			(entry) => entry.metric === "startup.fullInput",
		);
		assert(fullInput !== undefined, "comparison entry present");
		assertEqual(
			fullInput?.baseline,
			20_050,
			"baseline startup fullInput median",
		);
		assertEqual(
			fullInput?.candidate,
			18_000,
			"candidate startup fullInput median",
		);
		const totalFull = summary.delegate?.distributions.totalFullInput;
		assert(totalFull !== undefined, "total full input distribution");
		assertEqual(
			totalFull?.values.includes(42_000),
			true,
			"cumulative parent+child input for run 1",
		);
	});
	checks.run("report json round trip + raw files", () => {
		const samples: SampleReport[] = [
			startup(1, "baseline", 500, 20_000, 0),
			delegate(1, "baseline", 9_000, 30_000, 12_000),
		];
		const report: BenchReport = {
			schema: SCHEMA,
			harnessVersion: "self-test",
			generatedAtIso: new Date().toISOString(),
			config: {
				workflow: "all",
				samples: 1,
				target: undefined,
				mode: "baseline",
				codemode: "active",
				provider: opts.provider,
				model: opts.model,
				thinking: opts.thinking,
				modelRefresh: opts.modelRefresh,
				cwd: opts.cwd,
				agentDir: ctx.agentDir,
				coldNonce: false,
				modeCommand: opts.modeCommand,
				codemodeCommand: opts.codemodeCommand,
				startupPrompt: opts.startupPrompt,
				delegatePrompt: opts.delegatePrompt,
			},
			integrity: {
				subagentPackageRemoved: true,
				removedPackages: ["npm:@arhen/pi-core-subagent"],
				duplicateTools: [],
				extensionsLoaded: ["<target>"],
				modeCommandAvailable: false,
				notes: [],
			},
			summary: buildSummary(samples),
			samples,
			rawFiles: [],
			limitations: [],
			notes: [],
		};
		const outFile = join(dir, "report.json");
		writeReport(report, outFile);
		const raw = writeRawSamples(outFile, samples);
		assertEqual(raw.length, 2, "raw sample files");
		const parsed = JSON.parse(readFileSync(outFile, "utf8")) as BenchReport;
		assertEqual(parsed.schema, SCHEMA, "schema round trip");
		assertEqual(parsed.samples.length, 2, "samples round trip");
		assertEqual(parsed.summary.startup?.validSamples, 1, "summary round trip");
		assert(
			readFileSync(raw[0] as string, "utf8").includes("startup"),
			"raw file content",
		);
	});
}

export function runSelfTest(): number {
	const checks = new Checks();
	const dir = mkdtempSync(join(tmpdir(), "pi-subagent-bench-selftest-"));
	try {
		probeSelfTest(checks);
		childSessionSelfTest(checks, dir);
		codemodePlanSelfTest(checks);
		reportSelfTest(checks, dir);
		console.log(`SELF-TEST PASS (${checks.count} checks)`);
		return 0;
	} catch (error) {
		console.error(
			`SELF-TEST FAIL: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
