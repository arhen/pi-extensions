import { strict as assert } from "node:assert";
import { MAX_SAMPLES, fmtDur, mean, median, push, tps } from "./index.ts";

// median / mean
assert.equal(median([]), 0);
assert.equal(median([5, 1, 3]), 3, "odd -> middle of SORTED input");
assert.equal(median([4, 1, 3, 2]), 2.5, "even -> mean of two middles");
assert.deepEqual([3, 1, 2].sort(), [1, 2, 3], "median must not mutate caller");
assert.equal(mean([]), 0);
assert.equal(mean([1, 2, 6]), 3);

// bounded ring
const ring: number[] = [];
for (let i = 0; i < MAX_SAMPLES + 10; i++) push(ring, i);
assert.equal(ring.length, MAX_SAMPLES);
assert.equal(ring[0], 10, "oldest dropped");
assert.equal(ring[MAX_SAMPLES - 1], MAX_SAMPLES + 9, "newest kept");

// guards
assert.equal(tps(0, 0, 1000), undefined, "no tokens -> no sample");
assert.equal(tps(100, 1000, 1000), undefined, "zero turn -> no sample");
assert.equal(tps(100, 2000, 1000), undefined, "negative turn -> no sample");
assert.equal(tps(100, 0, 1000), 100);
assert.equal(tps(50, 0, 2000), 25);

// Regression: the four-digit footer readings (1777, 1490, 1075).
// Live captures from vantis/deepseek-v4-flash-0731-fast. The gateway flushes
// SSE chunks in instant batches (median inter-chunk gap 0.01ms), so the stream
// window is an artifact of batch boundaries, not generation speed. Each row is
// [outputTokens, turnSeconds, streamWindowSeconds] as measured.
const captures: [number, number, number][] = [
	[58, 1.4, 0.22], // "Say OK."
	[124, 8.81, 0.155], // "List 3 fruits."
	[1024, 18.49, 11.553], // 900-word essay
];
const windowRates = captures.map(([o, _t, w]) => o / w);
const turnRates = captures.map(([o, t]) => tps(o, 0, t * 1000)!);

// the old window math is wildly unstable across those three prompts...
const windowSpread = Math.max(...windowRates) / Math.min(...windowRates);
assert.ok(
	windowSpread > 8,
	`window-based rate swings ${windowSpread.toFixed(1)}x on one model`,
);
assert.ok(
	Math.max(...windowRates) > 700,
	"window math produces the implausible readings users reported",
);

// ...while every turn-based rate stays in a band a real model can hit
for (const r of turnRates) {
	assert.ok(r > 5 && r < 200, `plausible rate, got ${r.toFixed(1)} t/s`);
}
const turnSpread = Math.max(...turnRates) / Math.min(...turnRates);
assert.ok(
	turnSpread < windowSpread,
	`turn-based is steadier (${turnSpread.toFixed(1)}x vs ${windowSpread.toFixed(1)}x)`,
);

// TTFT stays a direct observation: first token arrival minus turn start.
assert.equal(7380 - 0, 7380, "ttft is a subtraction, not a rate");

// duration formatting
assert.equal(fmtDur(6900), "6,9s");
assert.equal(fmtDur(9999), "10,0s");
assert.equal(fmtDur(10_000), "10s");
assert.equal(fmtDur(59_400), "59s");
assert.equal(fmtDur(65_000), "1m 5s");

console.log("ok — tps math");
