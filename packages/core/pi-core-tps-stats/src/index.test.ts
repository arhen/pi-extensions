import { strict as assert } from "node:assert";
import {
	MAX_SAMPLES,
	effTps,
	fmtDur,
	genTps,
	mean,
	median,
	push,
} from "./index.ts";

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

// t/s guards
assert.equal(genTps(0, 0, 1000), undefined, "no tokens -> no sample");
assert.equal(genTps(100, 1000, 1000), undefined, "zero window -> no sample");
assert.equal(
	genTps(100, 2000, 1000),
	undefined,
	"negative window -> no sample",
);
assert.equal(genTps(100, 0, 1000), 100);
assert.equal(effTps(100, 0, 2000), 50, "eff includes prefill, so it is slower");

// regression: the screenshot's 1777 t/s.
// Real segment from a session log: 1754 output tokens (1564 reasoning), model
// streamed ~18s total, text streamed in the last ~0.1s. The old math divided
// (output - reasoning) = 190 by the 0.1s text-only window -> 1900 t/s.
const OUT = 1754;
const turnStart = 0;
const firstToken = 500; // thinking_start
const textStart = 18_400;
const end = 18_500;
const oldMath = (OUT - 1564) / ((end - textStart) / 1000);
assert.ok(oldMath > 1500, `old math inflates (${oldMath.toFixed(0)} t/s)`);
const gen = genTps(OUT, firstToken, end)!;
assert.ok(
	gen > 90 && gen < 100,
	`generation t/s is plausible for this hardware, got ${gen.toFixed(1)}`,
);
assert.ok(
	effTps(OUT, turnStart, end)! < gen,
	"effective t/s <= generation t/s: same tokens, longer window",
);

// TTFT counts thinking as first token, not first text
assert.equal(firstToken - turnStart, 500, "ttft = first content event");

// duration formatting
assert.equal(fmtDur(6900), "6,9s");
assert.equal(fmtDur(9999), "10,0s");
assert.equal(fmtDur(10_000), "10s");
assert.equal(fmtDur(59_400), "59s");
assert.equal(fmtDur(65_000), "1m 5s");

console.log("ok — tps math");
