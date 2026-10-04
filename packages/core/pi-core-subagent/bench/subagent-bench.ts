import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type BenchOptions,
	helpText,
	resolveOptions,
	UsageError,
} from "./lib/args.ts";
import {
	type BenchReport,
	buildSummary,
	defaultLimitations,
	fmt,
	HARNESS_VERSION,
	type SampleReport,
	SCHEMA,
	summarizeDelegateSample,
	summarizeStartupSample,
	writeRawSamples,
	writeReport,
} from "./lib/report.ts";
import {
	type RunContext,
	runDelegateSample,
	runStartupSample,
} from "./lib/samples.ts";
import { runSelfTest } from "./lib/selftest.ts";
import {
	buildParentSession,
	commandRegistered,
	inspectTarget,
	modeCommandText,
	type TargetInfo,
} from "./lib/session.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FALLBACK_COMMAND =
	"packages/core/pi-core-subagent/bench/subagent-bench.ts";

function displayCommand(): string {
	const absolute = fileURLToPath(import.meta.url);
	const rel = relative(process.cwd(), absolute);
	return rel.startsWith("..") ? FALLBACK_COMMAND : rel;
}

function sdkVersion(): string {
	try {
		const resolved = import.meta.resolve("@earendil-works/pi-coding-agent");
		const entry = resolved.startsWith("file:")
			? fileURLToPath(resolved)
			: resolved;
		let dir = dirname(entry);
		for (let i = 0; i < 6; i++) {
			const candidate = join(dir, "package.json");
			if (existsSync(candidate)) {
				const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
					name?: string;
					version?: string;
				};
				if (pkg.name === "@earendil-works/pi-coding-agent")
					return pkg.version ?? "unknown";
			}
			dir = dirname(dir);
		}
	} catch {}
	return "unknown";
}

function defaultOut(opts: BenchOptions): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(HERE, "results", `${stamp}-${opts.mode}-${opts.workflow}.json`);
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const item of items) {
		const id = key(item);
		if (seen.has(id)) continue;
		seen.add(id);
		result.push(item);
	}
	return result;
}

async function runDryRun(
	opts: BenchOptions,
	target: TargetInfo | undefined,
): Promise<number> {
	console.log(
		"dry-run: building settings/loader/session offline (no model calls)",
	);
	const agentDir = opts.agentDir ?? getAgentDir();
	console.log(
		`  target:  ${target?.path ?? "(none; installed packages minus pi-core-subagent only)"}`,
	);
	if (target?.exists)
		console.log(
			`           exists, ${target.bytes} bytes, sha256=${target.sha256?.slice(0, 16)}…`,
		);
	console.log(`  agentDir: ${agentDir}`);
	console.log(`  cwd:      ${opts.cwd}`);
	console.log(
		`  mode:     ${opts.mode}   codemode: ${opts.codemode}   modelRefresh: ${opts.modelRefresh}`,
	);
	console.log(
		`  command:  ${opts.modeCommand}${opts.codemodeCommand ? `  +  ${opts.codemodeCommand}` : ""}`,
	);
	let built: Awaited<ReturnType<typeof buildParentSession>>;
	try {
		built = await buildParentSession({ opts });
	} catch (error) {
		console.error(
			`dry-run FAILED: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}
	try {
		const active = built.session.getActiveToolNames().slice().sort();
		const command = commandRegistered(built.extensions, "subagents");
		console.log(
			`  model:    ${built.model.provider}/${built.model.id} (thinking ${built.model.thinkingLevel})`,
		);
		console.log(
			`  settings: removed packages: ${built.settings.packagesRemoved.join(", ") || "(none)"}`,
		);
		console.log(
			`            defaultTools ${JSON.stringify(built.settings.defaultToolsBefore ?? null)} -> ${JSON.stringify(built.settings.defaultToolsAfter ?? null)}`,
		);
		console.log(`            codemode: ${built.settings.codemodeNote}`);
		console.log(`  extensions (${built.extensions.length}):`);
		for (const ext of built.extensions) {
			console.log(
				`    ${ext.path}  tools=[${ext.tools.join(",")}] commands=[${ext.commands.join(",")}]`,
			);
		}
		console.log(
			`  duplicate tool registrations: ${built.duplicateTools.length === 0 ? "none" : JSON.stringify(built.duplicateTools)}`,
		);
		console.log(`  /subagents command registered: ${command ? "yes" : "no"}`);
		console.log(`  active tools (${active.length}): ${active.join(", ")}`);
		console.log(
			`  timings: total=${built.timings.totalMs.toFixed(0)}ms runtime=${built.timings.modelRuntimeMs.toFixed(0)}ms loader=${built.timings.loaderMs.toFixed(0)}ms session=${built.timings.sessionCreateMs.toFixed(0)}ms bind=${built.timings.bindExtensionsMs.toFixed(0)}ms`,
		);
		const commandProbe = async (
			label: string,
			text: string | undefined,
		): Promise<number> => {
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
			console.log(
				`  ${label}: preflight=${preflight.value ?? "none"} (expected handled)`,
			);
			if (preflight.value !== "handled") {
				console.error(`dry-run FAILED: ${label} leaked into a model run`);
				return 1;
			}
			return 0;
		};
		if (opts.mode !== "baseline") {
			const code = await commandProbe(
				"mode command",
				modeCommandText(opts.modeCommand, opts.mode),
			);
			if (code !== 0) return code;
		}
		if (opts.codemodeCommand.trim()) {
			const code = await commandProbe(
				"codemode command",
				opts.codemodeCommand.replaceAll("{state}", opts.codemode),
			);
			if (code !== 0) return code;
		}
		if (opts.mode !== "baseline" && !command && !opts.allowMissingModeCommand) {
			console.log(
				`  WARNING: mode=${opts.mode} needs /subagents but this target registers none; live runs will fail without --allow-missing-mode-command.`,
			);
		}
		console.log("dry-run OK (no API calls)");
		return 0;
	} finally {
		built.dispose();
	}
}

async function runLive(
	opts: BenchOptions,
	target: TargetInfo | undefined,
): Promise<number> {
	const outFile = opts.out ?? defaultOut(opts);
	const ctx: RunContext = {
		opts,
		target,
		agentDir: opts.agentDir ?? getAgentDir(),
	};
	const samples: SampleReport[] = [];
	console.log(
		`pi-core-subagent bench — target=${target?.path ?? "(none)"} mode=${opts.mode} codemode=${opts.codemode}`,
	);
	console.log(
		`model=${opts.provider}/${opts.model} thinking=${opts.thinking} refresh=${opts.modelRefresh} samples=${opts.samples}`,
	);
	console.log(`out=${outFile}`);

	if (opts.workflow === "startup" || opts.workflow === "all") {
		for (let index = 1; index <= opts.samples; index++) {
			process.stdout.write(`startup sample ${index}/${opts.samples} … `);
			const sample = await runStartupSample(ctx, index);
			samples.push(sample);
			console.log(summarizeStartupSample(sample));
			if (opts.verbose) {
				for (const call of sample.usage.perCall) {
					console.log(
						`    call@${call.atMs.toFixed(0)}ms in=${call.usage?.input ?? 0} cacheRead=${call.usage?.cacheRead ?? 0} cacheWrite=${call.usage?.cacheWrite ?? 0} out=${call.usage?.output ?? 0} reasoning=${call.usage?.reasoning ?? 0} stop=${call.stopReason ?? "?"}`,
					);
				}
			}
		}
	}
	if (opts.workflow === "delegate" || opts.workflow === "all") {
		for (let index = 1; index <= opts.samples; index++) {
			process.stdout.write(`delegate sample ${index}/${opts.samples} … `);
			const sample = await runDelegateSample(ctx, index);
			samples.push(sample);
			console.log(summarizeDelegateSample(sample));
			if (opts.verbose) {
				for (const call of sample.parentUsage.perCall) {
					console.log(
						`    parent call@${call.atMs.toFixed(0)}ms in=${call.usage?.input ?? 0} cacheRead=${call.usage?.cacheRead ?? 0} out=${call.usage?.output ?? 0} reasoning=${call.usage?.reasoning ?? 0} stop=${call.stopReason ?? "?"}`,
					);
				}
				console.log(
					`    routing: ${sample.routing.sequence.map((entry) => `${entry.tool}@${entry.atMs.toFixed(0)}ms`).join(" > ") || "none"}`,
				);
			}
		}
	}

	const extensions = dedupeBy(
		samples.flatMap((sample) => sample.extensions),
		(ext) => ext.path,
	);
	const duplicateTools = dedupeBy(
		samples.flatMap((sample) => sample.duplicateTools),
		(entry) => entry.tool,
	);
	const removedPackages = [
		...new Set(samples.flatMap((sample) => sample.settings.packagesRemoved)),
	];
	const delegateSamples = samples.filter(
		(sample) => sample.kind === "delegate",
	);
	const modeCommandAvailable = delegateSamples.some(
		(sample) =>
			sample.kind === "delegate" && sample.modeCommand?.available === true,
	);
	const firstBuild = samples.find((sample) => sample.build.modelRuntimeMs > 0);
	const notes: string[] = [
		`mode=${opts.mode}: ${opts.mode === "baseline" ? "no /subagents command invoked (frozen baseline contract)" : `invoked ${opts.modeCommand.replaceAll("{mode}", opts.mode)}`}`,
		`codemode=${opts.codemode}`,
		`installed package ${"@arhen/pi-core-subagent"} removed from the in-memory package list; target injected via additionalExtensionPaths`,
		`sdk=@earendil-works/pi-coding-agent@${sdkVersion()} runtime=bun${process.versions.bun ?? "?"} node=${process.versions.node}`,
	];
	const report: BenchReport = {
		schema: SCHEMA,
		harnessVersion: HARNESS_VERSION,
		generatedAtIso: new Date().toISOString(),
		config: {
			workflow: opts.workflow,
			samples: opts.samples,
			target,
			mode: opts.mode,
			codemode: opts.codemode,
			provider: opts.provider,
			model: opts.model,
			thinking: opts.thinking,
			modelRefresh: opts.modelRefresh,
			cwd: opts.cwd,
			agentDir: ctx.agentDir,
			coldNonce: opts.coldNonce,
			modeCommand: opts.modeCommand,
			codemodeCommand: opts.codemodeCommand,
			startupPrompt: opts.startupPrompt,
			delegatePrompt: opts.delegatePrompt,
		},
		integrity: {
			subagentPackageRemoved: removedPackages.length > 0,
			removedPackages,
			duplicateTools,
			extensionsLoaded: extensions.map((ext) => ext.path),
			modeCommandAvailable,
			notes,
		},
		summary: buildSummary(samples),
		samples,
		rawFiles: [],
		limitations: defaultLimitations(),
		notes: [
			...notes,
			`first sample build phases: ${firstBuild ? JSON.stringify(firstBuild.build) : "(no successful build)"}`,
			"reported token counts are raw provider usage; fullInput=input+cacheRead+cacheWrite and uncachedInput=input are both reported",
		],
	};
	if (opts.compareTo) {
		try {
			const baseline = JSON.parse(
				readFileSync(opts.compareTo, "utf8"),
			) as BenchReport;
			if (!Array.isArray(baseline.samples)) throw new Error("no samples array");
			report.summary.comparison = buildSummary([
				...baseline.samples,
				...samples,
			]).comparison;
			report.notes.push(
				`comparison merged with ${opts.compareTo} (${baseline.samples.length} baseline sample(s))`,
			);
		} catch (error) {
			console.error(
				`warning: --compare-to ${opts.compareTo} unreadable (${error instanceof Error ? error.message : String(error)})`,
			);
			report.notes.push(`--compare-to failed: ${opts.compareTo}`);
		}
	}
	report.rawFiles = writeRawSamples(outFile, samples);
	writeReport(report, outFile);

	console.log("");
	for (const sample of samples) {
		if (!sample.valid)
			console.log(
				`  warning: ${sample.kind} #${sample.sample} invalid: ${sample.invalidReason}`,
			);
	}
	if (report.summary.startup) {
		const d = report.summary.startup.distributions;
		console.log(
			`startup summary: valid=${report.summary.startup.validSamples}/${report.summary.startup.samples} setupMedian=${fmt(d.setupTotalMs?.median)} fullInputMedian=${d.fullInput?.median ?? "n/a"} uncachedMedian=${d.uncachedInput?.median ?? "n/a"} cacheReadMedian=${d.cacheRead?.median ?? "n/a"} declarationsMedian=${d.declarationCount?.median ?? "n/a"}`,
		);
	}
	if (report.summary.delegate) {
		const d = report.summary.delegate.distributions;
		console.log(
			`delegate summary: valid=${report.summary.delegate.validSamples}/${report.summary.delegate.samples} discoveryMedian=${fmt(d.discoveryMs?.median)} completionMedian=${fmt(d.completionMs?.median)} parentFullInputMedian=${d.parentFullInput?.median ?? "n/a"} childFullInputMedian=${d.childFullInput?.median ?? "n/a"} totalFullInputMedian=${d.totalFullInput?.median ?? "n/a"}`,
		);
	}
	const matched = report.summary.comparison.filter(
		(entry) => entry.baseline !== undefined && entry.candidate !== undefined,
	);
	if (matched.length > 0) {
		console.log(
			"baseline -> candidate (medians; only where both modes were run in one report):",
		);
		for (const entry of matched) {
			console.log(
				`  ${entry.metric}: ${entry.baseline ?? "n/a"} -> ${entry.candidate ?? "n/a"} (delta ${entry.delta ?? "n/a"}${entry.deltaPct === undefined ? "" : `, ${entry.deltaPct.toFixed(1)}%`})`,
			);
		}
	} else if (opts.mode !== "baseline") {
		console.log(
			"note: no matched baseline candidate in this report; run the baseline profile separately with --mode baseline",
		);
	}
	console.log(`report: ${outFile}`);
	console.log(
		`raw:    ${report.rawFiles.length} sample file(s) in ${report.rawFiles[0] ? dirname(report.rawFiles[0]) : "(none)"}`,
	);
	const validCount = samples.filter((sample) => sample.valid).length;
	if (validCount === 0) {
		console.error(
			"no valid samples collected — see report limitations and invalid reasons",
		);
		return 1;
	}
	return 0;
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		console.log(helpText(displayCommand()));
		return 0;
	}
	let opts: BenchOptions | undefined;
	try {
		opts = resolveOptions(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`error: ${error.message}\n`);
			console.error(`run with --help for usage`);
			return 2;
		}
		throw error;
	}
	if (!opts) {
		console.log(helpText(displayCommand()));
		return 0;
	}
	if (opts.selfTest) return runSelfTest();

	const target = opts.target ? inspectTarget(opts.target) : undefined;
	if (opts.target && !target?.exists) {
		console.error(`error: target does not exist: ${opts.target}`);
		return 2;
	}
	if (opts.dryRun) return runDryRun(opts, target);
	return runLive(opts, target);
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		console.error(
			`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
		);
		process.exitCode = 1;
	});
