import { fullInputOf, type RepeatIterationReport } from "./repeat.ts";
import { type Distribution, distribution } from "./report.ts";
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
