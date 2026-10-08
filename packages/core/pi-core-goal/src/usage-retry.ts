export interface UsageRetry {
	attempt: number;
	retryAt: number;
}

const MIN_RETRY_MS = 60_000;
const RESET_GRACE_MS = 30_000;
const BASE_RETRY_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

export function isUsageLimitError(error: string): boolean {
	if (
		/context[\s_-]*(?:length|window|limit)|prompt (?:is )?too (?:long|large)|insufficient_quota|usage_not_included|billing|payment|(?:insufficient|exhausted|not enough) (?:credits?|balance)|(?:credits?|balance) (?:are |is )?(?:insufficient|exhausted)|out of budget/i.test(
			error,
		)
	) {
		return false;
	}
	return /(?:usage|rate|quota)[\s_-]*(?:limit|exceed|exhaust)|(?:Go|Free)UsageLimitError|\b429\b|too many requests|resource[\s_-]*exhausted|(?:weekly|monthly|daily|session|request|subscription)[\s_-]+limit|\b(?:hit|reached|exceeded) (?:your |the )?limit\b|\blimits? (?:reached|exceeded|exhausted)\b/i.test(
		error,
	);
}

function durationMs(input: string): number {
	let total = 0;
	const units: Record<string, number> = {
		ms: 1,
		s: 1_000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
		w: 604_800_000,
	};
	for (const match of input.matchAll(
		/(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/gi,
	)) {
		const unit = match[2]!.toLowerCase();
		const key = unit.startsWith("millisecond") || unit === "ms" ? "ms" : unit[0]!;
		total += Number(match[1]) * units[key]!;
	}
	return total;
}

function clockResetAt(now: number, hour: number, minute: number, timeZone?: string): number | undefined {
	try {
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		const wallTime = (timestamp: number) => {
			const parts = Object.fromEntries(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
			return Date.UTC(
				Number(parts.year),
				Number(parts.month) - 1,
				Number(parts.day),
				Number(parts.hour),
				Number(parts.minute),
			);
		};
		const offsets = new Set(
			[-36, 0, 36, 72].map((hours) => {
				const timestamp = now + hours * 3_600_000;
				return wallTime(timestamp) - Math.floor(timestamp / 60_000) * 60_000;
			}),
		);
		let target = Math.floor(wallTime(now) / 86_400_000) * 86_400_000 + hour * 3_600_000 + minute * 60_000;
		for (let day = 0; day < 2; day++) {
			const candidates = [...offsets]
				.map((offset) => target - offset)
				.filter((timestamp) => wallTime(timestamp) === target);
			if (candidates.length === 0) return undefined;
			const upcoming = candidates.filter((timestamp) => timestamp >= now - RESET_GRACE_MS);
			if (upcoming.length > 0) return Math.max(now, Math.min(...upcoming));
			target += 86_400_000;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function resetHints(error: string, now: number): number[] {
	const hints: number[] = [];
	for (const match of error.matchAll(
		/["']?(?:resets_at|reset_at|resetAt|reset_time)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/gi,
	)) {
		const value = Number(match[1]);
		hints.push(value < 1e12 ? value * 1_000 : value);
	}
	for (const match of error.matchAll(/["']?retry[_-]after["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/gi)) {
		hints.push(now + Number(match[1]) * 1_000);
	}
	for (const match of error.matchAll(
		/(?:try again|retry|reset(?:s)?)(?:[_ -]after|\s+(?:in|after))\s*(?:~|about\s+|approximately\s+)?((?:\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b[\s,]*(?:and\s+)?)+)/gi,
	)) {
		hints.push(now + durationMs(match[1]!));
	}
	for (const match of error.matchAll(
		/(?:reset(?:s)?(?:[_ -]at)?|try again (?:at|after)|retry[_ -]after)["']?\s*[:=]?\s*["']?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/gi,
	)) {
		hints.push(Date.parse(match[1]!));
	}
	for (const match of error.matchAll(/retry-after\s*:\s*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),[^\n]+?GMT)/gi)) {
		hints.push(Date.parse(match[1]!));
	}
	for (const match of error.matchAll(
		/\bresets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm))?(?:\s*\(([^)]+)\)|\s+(UTC|GMT|[A-Za-z_]+\/[A-Za-z_/]+))?/gi,
	)) {
		if (match[2] === undefined && !match[3]) continue;
		let hour = Number(match[1]);
		const minute = Number(match[2] ?? 0);
		if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) continue;
		if (match[3]) hour = (hour % 12) + (match[3].toLowerCase() === "pm" ? 12 : 0);
		const timeZone = (match[4] ?? match[5])?.trim();
		const reset = clockResetAt(now, hour, minute, timeZone);
		if (reset !== undefined) hints.push(reset);
	}
	return hints.filter((value) => Number.isSafeInteger(value) && value >= now && value <= 8.64e15 - RESET_GRACE_MS);
}

export function nextUsageRetry(error: string, previousAttempt = 0, now = Date.now()): UsageRetry {
	const attempt = Math.max(0, Math.floor(previousAttempt)) + 1;
	const hints = resetHints(error, now);
	const retryAt =
		hints.length > 0
			? Math.max(now + MIN_RETRY_MS, ...hints.map((hint) => hint + RESET_GRACE_MS))
			: now + Math.min(MAX_BACKOFF_MS, BASE_RETRY_MS * 2 ** Math.min(attempt - 1, 4));
	return { attempt, retryAt };
}

export function normalizeUsageRetry(value: unknown): UsageRetry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const retry = value as Partial<UsageRetry>;
	if (
		typeof retry.attempt !== "number" ||
		!Number.isSafeInteger(retry.attempt) ||
		retry.attempt < 1 ||
		typeof retry.retryAt !== "number" ||
		!Number.isSafeInteger(retry.retryAt) ||
		retry.retryAt < 0 ||
		retry.retryAt > 8.64e15
	) {
		return undefined;
	}
	return { attempt: retry.attempt, retryAt: retry.retryAt };
}
