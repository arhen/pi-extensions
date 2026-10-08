import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type BenchOptions, resolveOptions, UsageError } from "./lib/args.ts";
import {
	DEFAULT_QUIESCE_MS,
	promptEmbedsControlledArguments,
	REPEAT_HARNESS_VERSION,
	REPEAT_SCHEMA,
	type RepeatReport,
	type RepeatSessionReport,
	runRepeatSession,
} from "./lib/repeat.ts";
import {
	buildRepeatSummary,
	type RepeatEpochStat,
	type RepeatMetricSummary,
	type RepeatSummary,
} from "./lib/repeat-summary.ts";
import { runRepeatSelfTest } from "./lib/repeat-synthetic.ts";
import {
	buildParentSession,
	commandRegistered,
	inspectTarget,
	modeCommandText,
	type TargetInfo,
} from "./lib/session.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FALLBACK_COMMAND = "packages/core/pi-core-subagent/bench/subagent-repeat-bench.ts";
const DEFAULT_TURNS = 5;

function displayCommand(): string {
	const absolute = fileURLToPath(import.meta.url);
	const rel = relative(process.cwd(), absolute);
	return rel.startsWith("..") ? FALLBACK_COMMAND : rel;
}

function extractTurns(argv: string[]): { argv: string[]; turns: number } {
	const out: string[] = [];
	let turns = DEFAULT_TURNS;
	const parse = (raw: string): number => {
		const value = Number.parseInt(raw, 10);
		if (!Number.isFinite(value) || value < 1) throw new UsageError(`--turns must be a positive integer (got "${raw}")`);
		return value;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--turns" || arg === "-T") {
			const raw = argv[++i];
			if (raw === undefined) throw new UsageError("missing value for --turns");
			turns = parse(raw);
			continue;
		}
		if (arg.startsWith("--turns=")) {
			turns = parse(arg.slice("--turns=".length));
			continue;
		}
		out.push(arg);
	}
	return { argv: out, turns };
}

function defaultOut(opts: BenchOptions, turns: number): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(HERE, "results", `${stamp}-repeat-${opts.mode}-${opts.samples}x${turns}.json`);
}

function fmtUsd(value: number | undefined): string {
	return value === undefined ? "n/a" : `$${value.toFixed(6)}`;
}

function fmtMs(value: number | undefined): string {
	return value === undefined ? "n/a" : `${value.toFixed(0)}ms`;
}

function metricOf(summary: RepeatSummary, metric: string): RepeatMetricSummary | undefined {
	return summary.metrics.find((entry) => entry.metric === metric);
}

function epochMean(stat: RepeatEpochStat | undefined): number | undefined {
	return stat?.sessionDistribution?.mean;
}

function summarizeSession(session: RepeatSessionReport): string {
	const valid = session.iterations.filter((iteration) => iteration.valid).length;
	const parent = session.cumulative.parent;
	if (session.valid) {
		return `ok setup=${session.setupMs.toFixed(0)}ms iterations=${valid}/${session.iterations.length} parentFullInput=${parent.input + parent.cacheRead + parent.cacheWrite} parentCacheWrite=${parent.cacheWrite} cost=${fmtUsd(session.cumulative.costEstimate)}`;
	}
	return `INVALID (${valid}/${session.iterations.length} valid): ${session.invalidReason}`;
}

function printSummary(summary: RepeatSummary): void {
	console.log("");
	console.log(
		`repeat summary: sessions=${summary.sessions} turns=${summary.turns} validIterations=${summary.validIterations}/${summary.totalIterations} setupMean=${fmtMs(summary.setupMs.distribution?.mean)}`,
	);
	for (const metric of [
		"dispatchToSettleMs",
		"parentFullInput",
		"parentCacheWrite",
		"totalFullInput",
		"totalCostEstimate",
	]) {
		const entry = metricOf(summary, metric);
		if (!entry) continue;
		const fmt =
			entry.unit === "usd"
				? fmtUsd
				: entry.unit === "ms"
					? fmtMs
					: (value: number | undefined) => String(value ?? "n/a");
		console.log(
			`  ${metric}: first=${fmt(epochMean(entry.first))} later(2..${summary.turns})=${fmt(epochMean(entry.later))} cumulative/session=${fmt(epochMean(entry.cumulative))}`,
		);
		const positions = entry.positions
			.filter((stat) => stat.sessionDistribution !== undefined)
			.map((stat) => `${stat.position}=${fmt(stat.sessionDistribution?.mean)}`)
			.join(" ");
		if (positions) console.log(`    positions: ${positions}`);
	}
	const cost = metricOf(summary, "totalCostEstimate");
	if (cost) {
		const perSession = cost.cumulative.bySession.map((value) => fmtUsd(value)).join(", ");
		const values = cost.cumulative.bySession;
		const total = values.every((value) => value !== undefined)
			? values.reduce<number>((sum, value) => sum + (value as number), 0)
			: undefined;
		console.log(`  valid-call cumulative cost per session: ${perSession} | total=${fmtUsd(total)}`);
	}
	console.log(
		"  note: epochs use valid calls only, clustered per session. sessions[].cumulative includes failed effort.",
	);
	console.log("  cost provenance: pi SDK catalog estimate (tokens x model catalog price), not a provider invoice.");
}

function writeRawSessions(outFile: string, sessions: RepeatSessionReport[]): string[] {
	const base = outFile.slice(outFile.lastIndexOf("/") + 1).replace(/\.json$/, "");
	const rawDir = join(dirname(outFile), `${base}.raw`);
	mkdirSync(rawDir, { recursive: true });
	const files: string[] = [];
	for (const session of sessions) {
		const file = join(rawDir, `session-${String(session.session).padStart(2, "0")}.json`);
		writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`);
		files.push(file);
	}
	return files;
}

async function runDryRun(opts: BenchOptions, target: TargetInfo | undefined, turns: number): Promise<number> {
	console.log(
		`repeat dry-run: ${opts.samples} fresh parent session(s) x ${turns} successive delegations (one session per column, never rebuilt)`,
	);
	console.log(`  target:  ${target?.path ?? "(none; installed packages minus pi-core-subagent only)"}`);
	if (target?.exists) console.log(`           exists, ${target.bytes} bytes, sha256=${target.sha256?.slice(0, 16)}…`);
	console.log(`  agentDir: ${opts.agentDir ?? getAgentDir()}`);
	console.log(`  cwd:      ${opts.cwd}`);
	console.log(`  mode:     ${opts.mode}   codemode: ${opts.codemode}   modelRefresh: ${opts.modelRefresh}`);
	console.log(`  command:  ${opts.modeCommand}${opts.codemodeCommand ? `  +  ${opts.codemodeCommand}` : ""}`);
	console.log(
		`  controlled child arguments embedded in --delegate-prompt: ${promptEmbedsControlledArguments(opts) ? "yes" : "NO"}`,
	);
	let built: Awaited<ReturnType<typeof buildParentSession>>;
	try {
		built = await buildParentSession({ opts });
	} catch (error) {
		console.error(`dry-run FAILED: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	try {
		const active = built.session.getActiveToolNames().slice().sort();
		const command = commandRegistered(built.extensions, "subagents");
		console.log(`  model:    ${built.model.provider}/${built.model.id} (thinking ${built.model.thinkingLevel})`);
		console.log(
			`  settings: removed packages: ${built.settings.packagesRemoved.join(", ") || "(none)"}; codemode: ${built.settings.codemodeNote}`,
		);
		console.log(`  extensions (${built.extensions.length}):`);
		for (const ext of built.extensions) {
			console.log(`    ${ext.path}  tools=[${ext.tools.join(",")}] commands=[${ext.commands.join(",")}]`);
		}
		console.log(
			`  duplicate tool registrations: ${built.duplicateTools.length === 0 ? "none" : JSON.stringify(built.duplicateTools)}`,
		);
		console.log(`  /subagents command registered: ${command ? "yes" : "no"}`);
		console.log(`  active tools (${active.length}): ${active.join(", ")}`);
		console.log(
			`  timings: total=${built.timings.totalMs.toFixed(0)}ms runtime=${built.timings.modelRuntimeMs.toFixed(0)}ms loader=${built.timings.loaderMs.toFixed(0)}ms session=${built.timings.sessionCreateMs.toFixed(0)}ms bind=${built.timings.bindExtensionsMs.toFixed(0)}ms`,
		);
		const commandProbe = async (label: string, text: string | undefined): Promise<number> => {
			if (!text) return 0;
			const name = text.trim().split(/\s+/)[0]?.replace(/^\//, "") ?? "";
			if (!commandRegistered(built.extensions, name)) {
				console.log(`  ${label}: /${name} not registered — skipped`);
				return 0;
			}
			const preflight: { value: string | undefined } = { value: undefined };
			await built.session.prompt(text, {
				preflightResult: (disposition) => {
					preflight.value = disposition;
				},
			});
			console.log(`  ${label}: preflight=${preflight.value ?? "none"} (expected handled)`);
			if (preflight.value !== "handled") {
				console.error(`dry-run FAILED: ${label} leaked into a model run`);
				return 1;
			}
			return 0;
		};
		if (opts.mode !== "baseline") {
			const code = await commandProbe("mode command", modeCommandText(opts.modeCommand, opts.mode));
			if (code !== 0) return code;
		}
		if (opts.codemodeCommand.trim()) {
			const code = await commandProbe("codemode command", opts.codemodeCommand.replaceAll("{state}", opts.codemode));
			if (code !== 0) return code;
		}
		if (!promptEmbedsControlledArguments(opts)) {
			console.error("dry-run FAILED: --delegate-prompt does not embed the exact controlled child arguments");
			return 1;
		}
		console.log(`dry-run OK (no API calls); quiesce window per iteration: ${DEFAULT_QUIESCE_MS}ms`);
		return 0;
	} finally {
		built.dispose();
	}
}

async function runLive(opts: BenchOptions, target: TargetInfo | undefined, turns: number): Promise<number> {
	const outFile = opts.out ?? defaultOut(opts, turns);
	const ctx = { opts, target, agentDir: opts.agentDir ?? getAgentDir() };
	const sessions: RepeatSessionReport[] = [];
	console.log(
		`pi-core-subagent repeated-use bench — target=${target?.path ?? "(none)"} mode=${opts.mode} codemode=${opts.codemode}`,
	);
	console.log(
		`model=${opts.provider}/${opts.model} thinking=${opts.thinking} sessions=${opts.samples} turns=${turns} refresh=${opts.modelRefresh}`,
	);
	console.log(`out=${outFile}`);
	for (let index = 1; index <= opts.samples; index++) {
		process.stdout.write(`repeat session ${index}/${opts.samples} (${turns} delegations) … `);
		const session = await runRepeatSession({ ctx, sessionIndex: index, turns });
		sessions.push(session);
		console.log(summarizeSession(session));
		if (opts.verbose) {
			for (const iteration of session.iterations) {
				console.log(
					`    iter ${iteration.iteration} ${iteration.valid ? "ok" : "INVALID"} route=${iteration.toolNames.join(">") || "none"} run=${iteration.runId ?? "none"} wall=${iteration.wallMs.toFixed(0)}ms parentCalls=${iteration.parent.modelCalls} requests=${iteration.parent.providerRequests} parentCost=${fmtUsd(iteration.parent.costEstimate)} childCalls=${iteration.child.modelCalls ?? "?"} childCost=${fmtUsd(iteration.child.costEstimate)}`,
				);
				if (!iteration.valid) console.log(`      reason: ${iteration.invalidReason}`);
			}
		}
	}
	const summary = buildRepeatSummary(sessions);
	const rawFiles = writeRawSessions(outFile, sessions);
	const report: RepeatReport = {
		schema: REPEAT_SCHEMA,
		harnessVersion: REPEAT_HARNESS_VERSION,
		generatedAtIso: new Date().toISOString(),
		costProvenance:
			"costUSD fields are pi SDK session-usage catalog estimates (model catalog prices applied to reported tokens), not provider invoices",
		config: {
			sessions: opts.samples,
			turns,
			target,
			mode: opts.mode,
			codemode: opts.codemode,
			provider: opts.provider,
			model: opts.model,
			thinking: opts.thinking,
			cwd: opts.cwd,
			agentDir: ctx.agentDir,
		},
		summary,
		sessions,
		limitations: [
			`${opts.samples} parent session(s) x ${turns} successive delegations: later positions are clustered within each conversation, not ${opts.samples * turns} independent sessions.`,
			"cost figures are SDK session-usage catalog estimates, not provider invoices.",
			"child arguments are fixed by lib/contract.ts; the only per-iteration prompt change is the numbered 'start a NEW independent run' header.",
			"a session stops early when a previous run would be reused; the invalid iteration, abort point and remaining prompts are preserved in the report and never silently retried or filtered.",
			"live comparisons do not preload synthetic discovery context; the parent session starts from the configured system prompt only.",
		],
		notes: [
			`quiesce window after each iteration: ${DEFAULT_QUIESCE_MS}ms of bus silence and an idle session before the next prompt.`,
			"parent usage/cost per iteration is sliced from message and provider-request watermarks at prompt dispatch, so prior turns are not re-counted.",
			"each iteration requires exactly one new run id, one child model call, zero child tool calls, BENCH_OK, and no worktree branch.",
			...summary.notes,
		],
	};
	mkdirSync(dirname(outFile), { recursive: true });
	writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
	printSummary(summary);
	for (const session of sessions) {
		if (!session.valid) console.log(`  warning: session ${session.session} invalid: ${session.invalidReason}`);
	}
	console.log(`report: ${outFile}`);
	console.log(`raw:    ${rawFiles.length} session file(s) in ${rawFiles[0] ? dirname(rawFiles[0]) : "(none)"}`);
	const allValid = sessions.every((session) => session.valid);
	if (!allValid) {
		console.error(
			"one or more sessions/iterations invalid — see reasons above and in the report (no retries performed)",
		);
		return 1;
	}
	return 0;
}

function helpText(command: string): string {
	return `pi-core-subagent repeated-use benchmark (successive delegations in one parent session)

Usage:
  bun ${command} [options]

Runs ${DEFAULT_TURNS} successive controlled delegations per parent session (default), reusing the
same parent conversation, model, thinking level and exact child arguments. The first delegation is
compared with positions 2..N and with the session cumulative. Every iteration must produce a NEW
run id; a repeated BENCH_OK from a previous run invalidates that iteration.

Options:
  -T, --turns <count>       successive delegations per session, default: ${DEFAULT_TURNS}
  -n, --samples <count>     fresh parent sessions, default: 3
  -t, --target <abs path>   extension entry path under test (required for live runs)
      --mode <baseline|direct|codemode|auto>   default: baseline
      --codemode <active|on|only|disabled>     default: active
  -o, --out <file>          report JSON path (default bench/results/<stamp>-repeat-<mode>-<n>x<T>.json)
      --cwd <dir>           session cwd, default: ~/Code
      --agent-dir <dir>     pi agent dir, default: resolved by the SDK
      --provider <id>       default: opencode-go
      --model <id>          default: deepseek-v4.1-flash
      --thinking <level>    default: max
      --model-refresh <offline|network>   default: offline
      --settle-timeout <ms> wait for agent_settled, default: 180000
      --child-timeout <ms>  wait for child completion, default: 180000
      --mode-command <template>       default: "/subagents mode {mode}"
      --codemode-command <template>   default: "" (not invoked)
      --dry-run             build settings/loader/session offline, no model calls
      --self-test           run synthetic repeated-session self-test, no API calls
      --verbose             print per-iteration progress
  -h, --help                this text

Offline verification (no API calls):
  bun ${command} --help
  bun ${command} --self-test
  bun ${command} --dry-run --target /tmp/pi-subagents-discovery.EqsijU/before/src/index.ts --mode codemode --codemode active

Live run (same target in both cases; sessions are never rebuilt between delegations):
  bun ${command} --target /tmp/pi-subagents-discovery.EqsijU/before/src/index.ts \\
      --mode codemode --codemode active --samples 3 --turns 5 --out bench/results/repeat-before.json
  bun ${command} --target packages/core/pi-core-subagent/src/index.ts \\
      --mode codemode --codemode active --samples 3 --turns 5 --out bench/results/repeat-after.json
`;
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		console.log(helpText(displayCommand()));
		return 0;
	}
	let opts: BenchOptions | undefined;
	let turns = DEFAULT_TURNS;
	try {
		const extracted = extractTurns(argv);
		turns = extracted.turns;
		opts = resolveOptions(extracted.argv);
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`error: ${error.message}\n`);
			console.error("run with --help for usage");
			return 2;
		}
		throw error;
	}
	if (!opts) {
		console.log(helpText(displayCommand()));
		return 0;
	}
	if (opts.selfTest) return runRepeatSelfTest();
	const target = opts.target ? inspectTarget(opts.target) : undefined;
	if (opts.target && !target?.exists) {
		console.error(`error: target does not exist: ${opts.target}`);
		return 2;
	}
	if (opts.dryRun) return runDryRun(opts, target, turns);
	return runLive(opts, target, turns);
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		console.error(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		process.exitCode = 1;
	});
