import { expect, test } from "bun:test";

import { isUsageLimitError, nextUsageRetry, normalizeUsageRetry } from "../src/usage-retry.ts";

const NOW = Date.parse("2026-06-01T00:00:00Z");

test("classifies subscription quotas and throttles, not context or billing failures", () => {
	for (const error of [
		"You have hit your ChatGPT usage limit. Try again in ~123 min.",
		"GoUsageLimitError: Monthly usage limit reached. Enable available balance usage.",
		"FreeUsageLimitError",
		'{"error":{"type":"usage_limit_reached"}}',
		"subscription_sharing_usage_limit_exceeded",
		"rate_limit_exceeded",
		"Quota exceeded",
		"429: Too Many Requests",
		"Weekly limit reached",
		"5-hour limit reached",
		"Maximum weekly usage limit reached for tokens",
		"You've reached your limit · resets 5pm",
	]) {
		expect(isUsageLimitError(error)).toBe(true);
	}
	for (const error of [
		"Context limit exceeded",
		"context_length_exceeded",
		"maximum context length is 200000 tokens",
		"Prompt is too long",
		"429 insufficient_quota: check your billing",
		"usage_not_included",
		"Insufficient credits",
		"429: Credit balance is exhausted",
		"429: Not enough credits",
		"Invalid API key",
		"Tool usage was invalid",
		"Connection terminated",
	]) {
		expect(isUsageLimitError(error)).toBe(false);
	}
});

test("honors relative reset hints with clock-skew grace", () => {
	for (const [error, delay] of [
		["Try again in ~123 min.", 123 * 60_000],
		["Rate limit resets in 2h 30m", 150 * 60_000],
		["Try again in 2 hours and 30 minutes", 150 * 60_000],
		["Retry after 1 day, 2 hours", 26 * 3_600_000],
		["reset after 1.5 hours", 90 * 60_000],
		["retry-after: 120", 120_000],
		['{"retry_after":3600}', 3_600_000],
	] as const) {
		expect(nextUsageRetry(error, 0, NOW)).toEqual({ attempt: 1, retryAt: NOW + delay + 30_000 });
	}
	expect(nextUsageRetry("Try again in 0 min.", 0, NOW).retryAt).toBe(NOW + 60_000);
	expect(nextUsageRetry("Try again in 1 second", 0, NOW).retryAt).toBe(NOW + 60_000);
});

test("honors weekly reset timestamps, ISO dates, and Retry-After dates", () => {
	const reset = NOW + 7 * 86_400_000;
	for (const error of [
		`{"error":{"resets_at":${reset / 1_000}}}`,
		`reset_at=${reset}`,
		`resets at ${new Date(reset).toISOString()}`,
		`{"reset_at":"${new Date(reset).toISOString()}"}`,
		`Retry-After: ${new Date(reset).toUTCString()}`,
	]) {
		expect(nextUsageRetry(error, 0, NOW).retryAt).toBe(reset + 30_000);
	}
	expect(nextUsageRetry(`Retry after 5 minutes. resets_at=${reset / 1_000}`, 0, NOW).retryAt).toBe(reset + 30_000);
});

test("honors clock-only reset hints in the stated timezone", () => {
	for (const [error, reset] of [
		["You've hit your limit · resets 5pm (Asia/Jakarta)", "2026-06-01T10:00:00Z"],
		["Usage limit resets at 5am (Asia/Jakarta)", "2026-06-01T22:00:00Z"],
		["Usage limit resets 17:30 UTC", "2026-06-01T17:30:00Z"],
		["Usage limit resets 12am (UTC)", "2026-06-01T00:00:00Z"],
		["Usage limit resets 12pm (UTC)", "2026-06-01T12:00:00Z"],
	] as const) {
		expect(nextUsageRetry(error, 0, NOW).retryAt).toBe(Math.max(NOW + 60_000, Date.parse(reset) + 30_000));
	}
});

test("clock reset without a timezone uses the machine's local timezone", () => {
	const expected = new Date(NOW);
	expected.setHours(17, 0, 0, 0);
	if (expected.getTime() < NOW) expected.setDate(expected.getDate() + 1);
	expect(nextUsageRetry("You've hit your limit · resets 5pm", 0, NOW).retryAt).toBe(expected.getTime() + 30_000);
});

test("clock reset handles DST changes and chooses the next occurrence during a repeated hour", () => {
	const spring = Date.parse("2026-03-08T05:00:00Z");
	expect(nextUsageRetry("resets 5pm (America/New_York)", 0, spring).retryAt).toBe(
		Date.parse("2026-03-08T21:00:00Z") + 30_000,
	);
	const fall = Date.parse("2026-11-01T05:45:00Z");
	expect(nextUsageRetry("resets 1:30am (America/New_York)", 0, fall).retryAt).toBe(
		Date.parse("2026-11-01T06:30:00Z") + 30_000,
	);
	expect(nextUsageRetry("resets 2:30am (America/New_York)", 0, spring).retryAt).toBe(spring + 5 * 60_000);
});

test("invalid clock hints fall back safely", () => {
	for (const error of ["resets 25:00 UTC", "resets 12:75am", "resets 0pm", "resets 5pm (Invalid/Zone)"]) {
		expect(nextUsageRetry(error, 0, NOW).retryAt).toBe(NOW + 5 * 60_000);
	}
});

test("unknown or stale reset hints back off without limiting retry attempts", () => {
	for (const [previous, minutes] of [
		[0, 5],
		[1, 10],
		[2, 20],
		[3, 40],
		[4, 60],
		[100, 60],
	]) {
		expect(nextUsageRetry("Usage limit reached", previous, NOW)).toEqual({
			attempt: previous! + 1,
			retryAt: NOW + minutes! * 60_000,
		});
	}
	expect(nextUsageRetry('resets_at=1 reset_at="invalid" retry_after=-10', 0, NOW).retryAt).toBe(NOW + 5 * 60_000);
	expect(nextUsageRetry("resets_at=9000000000000000", 0, NOW).retryAt).toBe(NOW + 5 * 60_000);
});

test("validates durable retry metadata", () => {
	expect(normalizeUsageRetry({ attempt: 2, retryAt: NOW })).toEqual({ attempt: 2, retryAt: NOW });
	for (const invalid of [
		null,
		{},
		{ attempt: 0, retryAt: NOW },
		{ attempt: 1.5, retryAt: NOW },
		{ attempt: 1, retryAt: -1 },
		{ attempt: 1, retryAt: Infinity },
		{ attempt: 1, retryAt: 9e15 },
	]) {
		expect(normalizeUsageRetry(invalid)).toBeUndefined();
	}
});
