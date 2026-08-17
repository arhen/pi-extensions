/**
 * Wave scheduling (Graph Protocol §2) + edge payload (§6).
 * Pure logic — no pi runtime needed.
 */
import { describe, expect, test } from "bun:test";
import { applyUpstream, resolveNeeds, runWaveScheduler, waveNotation } from "../src/graph.ts";

describe("resolveNeeds", () => {
	test("parallel with no needs is one wave", () => {
		expect(resolveNeeds([{ id: "a" }, { id: "b" }], "parallel")).toEqual([[], []]);
	});

	test("chain becomes needs:[previous] regardless of declared needs", () => {
		expect(resolveNeeds([{ id: "a" }, { id: "b" }, { id: "c" }], "chain")).toEqual([[], ["a"], ["b"]]);
	});

	test("default ids are task_N so needs can reference undeclared tasks", () => {
		expect(resolveNeeds([{}, { needs: ["task_1"] }], "parallel")).toEqual([[], ["task_1"]]);
	});

	test("duplicate needs collapse", () => {
		expect(resolveNeeds([{ id: "a" }, { id: "b", needs: ["a", "a"] }], "parallel")).toEqual([[], ["a"]]);
	});

	test("diamond resolves", () => {
		const edges = resolveNeeds(
			[{ id: "a" }, { id: "b", needs: ["a"] }, { id: "c", needs: ["a"] }, { id: "d", needs: ["b", "c"] }],
			"parallel",
		);
		expect(edges).toEqual([[], ["a"], ["a"], ["b", "c"]]);
	});

	test("unknown id rejected", () => {
		expect(() => resolveNeeds([{ id: "a", needs: ["ghost"] }], "parallel")).toThrow(/unknown task id: ghost/);
	});

	test("self-edge rejected", () => {
		expect(() => resolveNeeds([{ id: "a", needs: ["a"] }], "parallel")).toThrow(/cannot need itself/);
	});

	test("cycle rejected before anything spawns", () => {
		expect(() =>
			resolveNeeds(
				[
					{ id: "a", needs: ["b"] },
					{ id: "b", needs: ["a"] },
				],
				"parallel",
			),
		).toThrow(/Cycle in subagent needs/);
	});
});

describe("applyUpstream", () => {
	test("no needs passes the task through untouched", () => {
		expect(applyUpstream("do it", [], new Map())).toBe("do it");
	});

	test("upstream output is prepended, not just ordered", () => {
		const out = applyUpstream("write tests", ["a"], new Map([["a", "the plan"]]));
		expect(out).toContain("## Output of a");
		expect(out).toContain("the plan");
		expect(out.endsWith("write tests")).toBe(true);
	});

	test("multiple upstreams each get a block", () => {
		const out = applyUpstream(
			"merge",
			["a", "b"],
			new Map([
				["a", "A"],
				["b", "B"],
			]),
		);
		expect(out).toContain("## Output of a");
		expect(out).toContain("## Output of b");
	});

	test("{previous} still expands for legacy chain prompts", () => {
		expect(applyUpstream("build on: {previous}", ["a"], new Map([["a", "STEP1"]]))).toContain("build on: STEP1");
	});

	test("{previous} with no upstream is emptied and flagged", () => {
		const out = applyUpstream("build on: {previous}", [], new Map());
		expect(out.split("\n")[0]).toBe("build on: "); // placeholder substituted, not left literal
		expect(out).toContain("was empty");
	});

	test("$ in upstream output is not treated as a replacement pattern", () => {
		expect(applyUpstream("use {previous}", ["a"], new Map([["a", "$& $1 cost"]]))).toContain("use $& $1 cost");
	});
});

describe("wave frontier (real scheduler)", () => {
	async function execute(
		tasks: { id: string; needs: string[] }[],
		opts: { concurrency?: number; fail?: string[] } = {},
	): Promise<string[]> {
		const outputs = new Map<string, string>();
		const settled = new Set<string>();
		const order: string[] = [];
		await runWaveScheduler(tasks, opts.concurrency ?? 3, outputs, settled, async (task) => {
			order.push(task.id);
			if (opts.fail?.includes(task.id)) return; // upstream "failed": no output recorded
			outputs.set(task.id, `out-${task.id}`);
		});
		return order;
	}

	test("independent tasks form a single wave", async () => {
		expect(
			await execute([
				{ id: "a", needs: [] },
				{ id: "b", needs: [] },
			]),
		).toEqual(["a", "b"]);
	});

	test("diamond runs as 3 waves with b,c parallel", async () => {
		expect(
			await execute([
				{ id: "a", needs: [] },
				{ id: "b", needs: ["a"] },
				{ id: "c", needs: ["a"] },
				{ id: "d", needs: ["b", "c"] },
			]),
		).toEqual(["a", "b", "c", "d"]);
	});

	test("chain degenerates to one task per wave", async () => {
		expect(
			await execute([
				{ id: "a", needs: [] },
				{ id: "b", needs: ["a"] },
				{ id: "c", needs: ["b"] },
			]),
		).toEqual(["a", "b", "c"]);
	});

	test("concurrency bounds the wave width", async () => {
		let active = 0;
		let maxActive = 0;
		await runWaveScheduler(
			[
				{ id: "a", needs: [] },
				{ id: "b", needs: [] },
				{ id: "c", needs: [] },
				{ id: "d", needs: [] },
			],
			2,
			new Map(),
			new Set(),
			async (_task) => {
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((r) => setTimeout(r, 5));
				active--;
			},
		);
		expect(maxActive).toBeLessThanOrEqual(2);
	});

	test("broken upstream skips the dependent, not the whole run", async () => {
		const outputs = new Map<string, string>();
		const settled = new Set<string>();
		const ran: string[] = [];
		const { skipped } = await runWaveScheduler(
			[
				{ id: "a", needs: [] },
				{ id: "b", needs: ["a"] },
				{ id: "c", needs: ["a"] },
				{ id: "d", needs: ["b", "c"] },
			],
			3,
			outputs,
			settled,
			async (task) => {
				ran.push(task.id);
				// a produces no output → everything downstream of it is broken
				if (task.id !== "a") outputs.set(task.id, "x");
			},
		);
		expect(ran).toEqual(["a"]);
		expect(skipped.map((s) => s.id).sort()).toEqual(["b", "c", "d"]);
		expect(skipped.find((s) => s.id === "b")?.needs).toEqual(["a"]);
	});

	test("canceled upstream (settled, no output) skips the dependent without running it", async () => {
		const outputs = new Map<string, string>();
		const settled = new Set<string>(["a"]); // a canceled before start
		const ran: string[] = [];
		const { skipped } = await runWaveScheduler(
			[{ id: "b", needs: ["a"] }], // caller filters pre-settled tasks out, like executeTasks does
			3,
			outputs,
			settled,
			async (task) => {
				ran.push(task.id);
				outputs.set(task.id, "x");
			},
		);
		expect(ran).toEqual([]);
		expect(skipped.map((s) => s.id)).toEqual(["b"]);
	});
});

describe("waveNotation (§2 rendering)", () => {
	test("flat fan-out gets no graph vocabulary", () => {
		expect(waveNotation([{ id: "a" }, { id: "b" }])).toBe("");
	});

	test("fan-in renders waves and a gate", () => {
		expect(waveNotation([{ id: "api" }, { id: "db" }, { id: "doc", needs: ["api", "db"] }])).toBe(
			"wave1[api ∥ db] → gate → wave2[doc]",
		);
	});

	test("diamond renders 3 waves", () => {
		expect(
			waveNotation([
				{ id: "audit" },
				{ id: "sec", needs: ["audit"] },
				{ id: "perf", needs: ["audit"] },
				{ id: "doc", needs: ["sec", "perf"] },
			]),
		).toBe("wave1[audit] → gate → wave2[sec ∥ perf] → gate → wave3[doc]");
	});

	test("half-streamed args still render: unresolved tasks land in a trailing wave", () => {
		// "doc" needs an id the model has not typed yet.
		expect(waveNotation([{ id: "api" }, { id: "doc", needs: ["db"] }])).toBe("wave1[api] → gate → wave2[doc]");
	});

	test("long graphs collapse to counts, keeping the shape", () => {
		const tasks = [
			{ id: "a-very-long-agent-id-one" },
			{ id: "a-very-long-agent-id-two" },
			{ id: "a-very-long-agent-id-three" },
			{
				id: "downstream-with-a-long-name",
				needs: ["a-very-long-agent-id-one", "a-very-long-agent-id-two", "a-very-long-agent-id-three"],
			},
		];
		expect(waveNotation(tasks)).toBe("wave1[3] → gate → wave2[1]");
	});
});
