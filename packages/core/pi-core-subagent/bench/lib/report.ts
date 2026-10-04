import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BenchMode, CodemodeState, ModelRefresh, Workflow } from "./args.ts";
import type { BusNotification, MessageRecord, UsageCounts } from "./probe.ts";
import { emptyUsage } from "./probe.ts";
import type {
	BuildTimings,
	DuplicateTool,
	ExtensionDescription,
	ModelIdentity,
	ProviderRequestCapture,
	SettingsDiagnostics,
	TargetInfo,
} from "./session.ts";

export const SCHEMA = "pi-core-subagent-bench/v1";
export const HARNESS_VERSION = "1.0.0";

export interface Distribution {
	n: number;
	min: number;
	max: number;
	mean: number;
	median: number;
	p25: number;
	p75: number;
	stdev: number;
	values: number[];
}

export function distribution(values: number[]): Distribution | undefined {
	const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	if (finite.length === 0) return undefined;
	const n = finite.length;
	const mean = finite.reduce((sum, value) => sum + value, 0) / n;
	const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
	const quantile = (q: number): number => {
		const index = (n - 1) * q;
		const low = Math.floor(index);
		const high = Math.ceil(index);
		const lowValue = finite[low] as number;
		const highValue = finite[high] as number;
		return lowValue + (highValue - lowValue) * (index - low);
	};
	return {
		n,
		min: finite[0] as number,
		max: finite[n - 1] as number,
		mean,
		median: quantile(0.5),
		p25: quantile(0.25),
		p75: quantile(0.75),
		stdev: Math.sqrt(variance),
		values: finite,
	};
}

export interface UsageBreakdown {
	calls: number;
	perCall: Array<{
		atMs: number;
		role: string;
		usage: UsageCounts | undefined;
		stopReason: string | undefined;
	}>;
	total: UsageCounts;
	/** input + cacheRead + cacheWrite */
	fullInput: number;
	/** input + cacheRead, the formula called out in the acceptance matrix */
	inputPlusCacheRead: number;
	uncachedInput: number;
	cacheState: "cold-observed" | "warm-observed" | "cache-unknown" | "no-usage";
}

export function usageBreakdown(messages: MessageRecord[]): UsageBreakdown {
	const perCall = messages
		.filter((message) => message.role === "assistant")
		.map((message) => ({
			atMs: message.atMs,
			role: message.role,
			usage: message.usage,
			stopReason: message.stopReason,
		}));
	const total = emptyUsage();
	for (const call of perCall) {
		if (!call.usage) continue;
		total.input += call.usage.input;
		total.output += call.usage.output;
		total.cacheRead += call.usage.cacheRead;
		total.cacheWrite += call.usage.cacheWrite;
		total.totalTokens += call.usage.totalTokens;
		total.cost += call.usage.cost;
		if (call.usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + call.usage.reasoning;
	}
	const cacheState: UsageBreakdown["cacheState"] =
		perCall.length === 0
			? "no-usage"
			: total.cacheRead > 0
				? "warm-observed"
				: total.cacheWrite > 0
					? "cold-observed"
					: "cache-unknown";
	return {
		calls: perCall.length,
		perCall,
		total,
		fullInput: total.input + total.cacheRead + total.cacheWrite,
		inputPlusCacheRead: total.input + total.cacheRead,
		uncachedInput: total.input,
		cacheState,
	};
}

export interface StreamTimings {
	firstMessageUpdateMs: number | undefined;
	firstThinkingMs: number | undefined;
	firstTextMs: number | undefined;
	promptReturnMs: number | undefined;
	settledMs: number | undefined;
	wallMs: number;
}

export interface DeclaredManifest {
	requestCount: number;
	firstRequestToolCount: number | undefined;
	firstRequestToolNames: string[] | undefined;
	firstRequestToolsJsonBytes: number | undefined;
	firstRequestPerTool: ProviderRequestCapture["perTool"];
	firstRequestSystemChars: number | undefined;
	firstRequestPayloadHash: string | undefined;
	lastRequestToolCount: number | undefined;
	requests: ProviderRequestCapture[];
}

export function declaredManifest(requests: ProviderRequestCapture[]): DeclaredManifest {
	const first = requests[0];
	const last = requests[requests.length - 1];
	return {
		requestCount: requests.length,
		firstRequestToolCount: first?.toolCount,
		firstRequestToolNames: first?.toolNames,
		firstRequestToolsJsonBytes: first?.toolsJsonBytes,
		firstRequestPerTool: first?.perTool,
		firstRequestSystemChars: first?.systemChars,
		firstRequestPayloadHash: first?.payloadHash,
		lastRequestToolCount: last?.toolCount,
		requests,
	};
}

export interface StartupSampleReport {
	kind: "startup";
	sample: number;
	valid: boolean;
	invalidReason?: string;
	startedAtIso: string;
	target: TargetInfo;
	mode: BenchMode;
	codemode: CodemodeState;
	cwd: string;
	model: ModelIdentity;
	nonce?: string;
	prompt: string;
	preflight: string | undefined;
	modeCommand?: DelegateSampleReport["modeCommand"];
	codemodeCommand?: DelegateSampleReport["codemodeCommand"];
	readyAtMs: number;
	build: BuildTimings;
	stream: StreamTimings;
	usage: UsageBreakdown;
	activeTools: string[];
	activeToolCount: number;
	declared: DeclaredManifest;
	systemPromptChars: number;
	systemPromptSha256: string;
	answerText: string | undefined;
	extensions: ExtensionDescription[];
	duplicateTools: DuplicateTool[];
	settings: SettingsDiagnostics;
	errors: string[];
}

export interface DelegateChildReport {
	runId: string | undefined;
	taskId: string | undefined;
	agent: string | undefined;
	status: string | undefined;
	model: string | undefined;
	provider: string | undefined;
	thinking: string | undefined;
	tools: string[] | undefined;
	sessionFile: string | undefined;
	branch: string | undefined;
	isolation: string | undefined;
	usage: UsageCounts | undefined;
	usageSource: "run-snapshot" | "session-file" | "none";
	toolCalls: number | undefined;
	modelCalls: number | undefined;
	finalText: string | undefined;
	containsBenchOk: boolean | undefined;
	startedAt: number | undefined;
	endedAt: number | undefined;
}

export interface DelegateSampleReport {
	kind: "delegate";
	sample: number;
	valid: boolean;
	invalidReason?: string;
	startedAtIso: string;
	target: TargetInfo;
	mode: BenchMode;
	codemode: CodemodeState;
	cwd: string;
	model: ModelIdentity;
	nonce?: string;
	prompt: string;
	modeCommand:
		| {
				text: string | undefined;
				available: boolean;
				preflight: string | undefined;
				modelCalls: number;
		  }
		| undefined;
	codemodeCommand:
		| {
				text: string | undefined;
				available: boolean;
				preflight: string | undefined;
				modelCalls: number;
		  }
		| undefined;
	routing: {
		sequence: Array<{
			tool: string;
			atMs: number;
			endMs: number | undefined;
			isError: boolean | undefined;
			argsPreview: string;
		}>;
		delegated: boolean;
		runIds: string[];
		toolCalls: number;
		modelCalls: number;
		usedAwait: boolean;
		usedAutoAwait: boolean;
	};
	readyAtMs: number;
	build: BuildTimings;
	stream: StreamTimings;
	parentUsage: UsageBreakdown;
	parentFinalContext:
		| {
				input: number;
				cacheRead: number;
				cacheWrite: number;
				fullInput: number;
		  }
		| undefined;
	parentAnswerText: string | undefined;
	child: DelegateChildReport;
	bus: BusNotification[];
	latency: {
		discoveryMs: number | undefined;
		dispatchMs: number | undefined;
		firstChildOutputMs: number | undefined;
		completionMs: number | undefined;
		settledMs: number | undefined;
		wallMs: number;
	};
	declared: DeclaredManifest;
	systemPromptChars: number;
	systemPromptSha256: string;
	extensions: ExtensionDescription[];
	duplicateTools: DuplicateTool[];
	settings: SettingsDiagnostics;
	errors: string[];
}

export type SampleReport = StartupSampleReport | DelegateSampleReport;

export interface SummaryGroup {
	samples: number;
	validSamples: number;
	distributions: Record<string, Distribution | undefined>;
}

export interface ComparisonEntry {
	metric: string;
	baseline: number | undefined;
	candidate: number | undefined;
	delta: number | undefined;
	deltaPct: number | undefined;
}

export interface BenchReport {
	schema: typeof SCHEMA;
	harnessVersion: string;
	generatedAtIso: string;
	config: {
		workflow: Workflow;
		samples: number;
		target: TargetInfo | undefined;
		mode: BenchMode;
		codemode: CodemodeState;
		provider: string;
		model: string;
		thinking: string;
		modelRefresh: ModelRefresh;
		cwd: string;
		agentDir: string;
		coldNonce: boolean;
		modeCommand: string;
		codemodeCommand: string;
		startupPrompt: string;
		delegatePrompt: string;
	};
	integrity: {
		subagentPackageRemoved: boolean;
		removedPackages: string[];
		duplicateTools: DuplicateTool[];
		extensionsLoaded: string[];
		modeCommandAvailable: boolean;
		notes: string[];
	};
	summary: {
		startup?: SummaryGroup;
		delegate?: SummaryGroup;
		comparison: ComparisonEntry[];
	};
	samples: SampleReport[];
	rawFiles: string[];
	limitations: string[];
	notes: string[];
}

function dist(values: Array<number | undefined>): Distribution | undefined {
	return distribution(values.map((value) => value ?? Number.NaN));
}

export function buildSummary(samples: SampleReport[]): BenchReport["summary"] {
	const startup = samples.filter((sample): sample is StartupSampleReport => sample.kind === "startup");
	const delegate = samples.filter((sample): sample is DelegateSampleReport => sample.kind === "delegate");
	const startupValid = startup.filter((sample) => sample.valid);
	const delegateValid = delegate.filter((sample) => sample.valid);
	const startupGroup: SummaryGroup | undefined =
		startup.length > 0
			? {
					samples: startup.length,
					validSamples: startupValid.length,
					distributions: {
						setupTotalMs: dist(startupValid.map((s) => s.build.totalMs)),
						loaderMs: dist(startupValid.map((s) => s.build.loaderMs)),
						sessionCreateMs: dist(startupValid.map((s) => s.build.sessionCreateMs)),
						firstThinkingMs: dist(startupValid.map((s) => s.stream.firstThinkingMs)),
						firstTextMs: dist(startupValid.map((s) => s.stream.firstTextMs)),
						settledMs: dist(startupValid.map((s) => s.stream.settledMs)),
						uncachedInput: dist(startupValid.map((s) => s.usage.uncachedInput)),
						cacheRead: dist(startupValid.map((s) => s.usage.total.cacheRead)),
						cacheWrite: dist(startupValid.map((s) => s.usage.total.cacheWrite)),
						output: dist(startupValid.map((s) => s.usage.total.output)),
						reasoning: dist(startupValid.map((s) => s.usage.total.reasoning)),
						fullInput: dist(startupValid.map((s) => s.usage.fullInput)),
						declarationCount: dist(startupValid.map((s) => s.declared.firstRequestToolCount)),
					},
				}
			: undefined;
	const delegateGroup: SummaryGroup | undefined =
		delegate.length > 0
			? {
					samples: delegate.length,
					validSamples: delegateValid.length,
					distributions: {
						discoveryMs: dist(delegateValid.map((s) => s.latency.discoveryMs)),
						dispatchMs: dist(delegateValid.map((s) => s.latency.dispatchMs)),
						firstChildOutputMs: dist(delegateValid.map((s) => s.latency.firstChildOutputMs)),
						completionMs: dist(delegateValid.map((s) => s.latency.completionMs)),
						settledMs: dist(delegateValid.map((s) => s.latency.settledMs)),
						parentUncachedInput: dist(delegateValid.map((s) => s.parentUsage.uncachedInput)),
						parentCacheRead: dist(delegateValid.map((s) => s.parentUsage.total.cacheRead)),
						parentOutput: dist(delegateValid.map((s) => s.parentUsage.total.output)),
						parentFullInput: dist(delegateValid.map((s) => s.parentUsage.fullInput)),
						parentModelCalls: dist(delegateValid.map((s) => s.parentUsage.calls)),
						parentToolCalls: dist(delegateValid.map((s) => s.routing.toolCalls)),
						childUncachedInput: dist(delegateValid.map((s) => s.child.usage?.input)),
						childCacheRead: dist(delegateValid.map((s) => s.child.usage?.cacheRead)),
						childOutput: dist(delegateValid.map((s) => s.child.usage?.output)),
						childFullInput: dist(
							delegateValid.map((s) =>
								s.child.usage ? s.child.usage.input + s.child.usage.cacheRead + s.child.usage.cacheWrite : undefined,
							),
						),
						childModelCalls: dist(delegateValid.map((s) => s.child.modelCalls)),
						totalFullInput: dist(
							delegateValid.map(
								(s) =>
									s.parentUsage.fullInput +
									(s.child.usage ? s.child.usage.input + s.child.usage.cacheRead + s.child.usage.cacheWrite : 0),
							),
						),
					},
				}
			: undefined;

	const baselineStartup = startupValid.filter((s) => s.mode === "baseline");
	const candidateStartup = startupValid.filter((s) => s.mode !== "baseline");
	const baselineDelegate = delegateValid.filter((s) => s.mode === "baseline");
	const candidateDelegate = delegateValid.filter((s) => s.mode !== "baseline");
	const comparisonEntry = (name: string, base: number[], candidate: number[]): ComparisonEntry | undefined => {
		const baseValue = distribution(base)?.median;
		const candidateValue = distribution(candidate)?.median;
		if (baseValue === undefined && candidateValue === undefined) return undefined;
		const delta = baseValue !== undefined && candidateValue !== undefined ? candidateValue - baseValue : undefined;
		return {
			metric: name,
			baseline: baseValue,
			candidate: candidateValue,
			delta,
			deltaPct: delta !== undefined && baseValue ? (delta / baseValue) * 100 : undefined,
		};
	};
	const pickStartup = (list: StartupSampleReport[], pick: (s: StartupSampleReport) => number | undefined): number[] =>
		list.map(pick).filter((value): value is number => typeof value === "number");
	const pickDelegate = (
		list: DelegateSampleReport[],
		pick: (s: DelegateSampleReport) => number | undefined,
	): number[] => list.map(pick).filter((value): value is number => typeof value === "number");
	const comparison = [
		comparisonEntry(
			"startup.setupTotalMs",
			pickStartup(baselineStartup, (s) => s.build.totalMs),
			pickStartup(candidateStartup, (s) => s.build.totalMs),
		),
		comparisonEntry(
			"startup.uncachedInput",
			pickStartup(baselineStartup, (s) => s.usage.uncachedInput),
			pickStartup(candidateStartup, (s) => s.usage.uncachedInput),
		),
		comparisonEntry(
			"startup.fullInput",
			pickStartup(baselineStartup, (s) => s.usage.fullInput),
			pickStartup(candidateStartup, (s) => s.usage.fullInput),
		),
		comparisonEntry(
			"startup.declarationCount",
			pickStartup(baselineStartup, (s) => s.declared.firstRequestToolCount),
			pickStartup(candidateStartup, (s) => s.declared.firstRequestToolCount),
		),
		comparisonEntry(
			"startup.settledMs",
			pickStartup(baselineStartup, (s) => s.stream.settledMs),
			pickStartup(candidateStartup, (s) => s.stream.settledMs),
		),
		comparisonEntry(
			"delegate.discoveryMs",
			pickDelegate(baselineDelegate, (s) => s.latency.discoveryMs),
			pickDelegate(candidateDelegate, (s) => s.latency.discoveryMs),
		),
		comparisonEntry(
			"delegate.completionMs",
			pickDelegate(baselineDelegate, (s) => s.latency.completionMs),
			pickDelegate(candidateDelegate, (s) => s.latency.completionMs),
		),
		comparisonEntry(
			"delegate.parentFullInput",
			pickDelegate(baselineDelegate, (s) => s.parentUsage.fullInput),
			pickDelegate(candidateDelegate, (s) => s.parentUsage.fullInput),
		),
		comparisonEntry(
			"delegate.parentModelCalls",
			pickDelegate(baselineDelegate, (s) => s.parentUsage.calls),
			pickDelegate(candidateDelegate, (s) => s.parentUsage.calls),
		),
		comparisonEntry(
			"delegate.childFullInput",
			pickDelegate(baselineDelegate, (s) =>
				s.child.usage ? s.child.usage.input + s.child.usage.cacheRead + s.child.usage.cacheWrite : undefined,
			),
			pickDelegate(candidateDelegate, (s) =>
				s.child.usage ? s.child.usage.input + s.child.usage.cacheRead + s.child.usage.cacheWrite : undefined,
			),
		),
	].filter((entry): entry is ComparisonEntry => entry !== undefined);
	return { startup: startupGroup, delegate: delegateGroup, comparison };
}

export function writeReport(report: BenchReport, outFile: string): void {
	mkdirSync(dirname(outFile), { recursive: true });
	writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
}

export function writeRawSamples(outFile: string, samples: SampleReport[]): string[] {
	const base = outFile.slice(outFile.lastIndexOf("/") + 1).replace(/\.json$/, "");
	const rawDir = join(dirname(outFile), `${base}.raw`);
	mkdirSync(rawDir, { recursive: true });
	const files: string[] = [];
	for (const sample of samples) {
		const name = `${String(sample.sample).padStart(2, "0")}-${sample.kind}.json`;
		const file = join(rawDir, name);
		writeFileSync(file, `${JSON.stringify(sample, null, 2)}\n`);
		files.push(file);
	}
	return files;
}

export function defaultLimitations(): string[] {
	return [
		"Small samples: the default 3 samples per profile are indicative only; no p95 or significance claims.",
		"Fresh session is not the same as a cold server-side prompt cache. Cache state is only what the provider reports: 'cold-observed' means cacheRead==0 and cacheWrite>0; 'warm-observed' means cacheRead>0; 'cache-unknown' means the provider reported neither.",
		"Declared-tool manifests come from the actual outgoing provider request (before_provider_request). Tools reachable only through codemode ALL_TOOLS/searchTools may not be individually enumerated; the codemode declaration size is measured instead.",
		"Child usage is 'when available': a run snapshot when the parent fetched status/result, else the persisted child session JSONL; a child killed before persisting has no usage.",
		"Registry/typecheck evidence is not execution evidence: this harness reports only what the sampled model calls actually did, and lists anything it could not observe as unverified.",
	];
}

export function fmt(value: number | undefined): string {
	return value === undefined ? "n/a" : `${value.toFixed(0)}ms`;
}

export function summarizeStartupSample(sample: StartupSampleReport): string {
	return `startup #${sample.sample} ${sample.valid ? "ok" : "INVALID"} setup=${sample.build.totalMs.toFixed(0)}ms firstText=${fmt(sample.stream.firstTextMs)} settled=${fmt(sample.stream.settledMs)} tools=${sample.declared.firstRequestToolCount ?? "?"} uncached=${sample.usage.uncachedInput} cacheRead=${sample.usage.total.cacheRead} out=${sample.usage.total.output} (${sample.usage.cacheState})`;
}

export function summarizeDelegateSample(sample: DelegateSampleReport): string {
	return `delegate #${sample.sample} ${sample.valid ? "ok" : "INVALID"} route=${sample.routing.sequence.map((s) => s.tool).join(">") || "none"} completion=${fmt(sample.latency.completionMs)} parentCalls=${sample.parentUsage.calls} childCalls=${sample.child.modelCalls ?? "?"} childUsage=${sample.child.usageSource} status=${sample.child.status ?? "?"}`;
}
