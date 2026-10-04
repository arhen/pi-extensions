import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ParkedMsg, SubagentManager } from "../../src/manager.ts";
import { MAX_TASKS } from "../../src/types.ts";

const stubPi = {
	events: { emit() {} },
	sendUserMessage() {},
} as unknown as ExtensionAPI;
const stubCtx = { cwd: "/tmp", hasUI: false } as unknown as ExtensionContext;
const makeManager = (): SubagentManager => new SubagentManager(stubPi);

interface LiveChild {
	abort: () => void;
	dispose: () => void;
	steer: (message: string) => void;
}

function injectLiveChild(manager: SubagentManager, key: string, steered: string[]): void {
	(manager as unknown as { liveChildren: Map<string, LiveChild> }).liveChildren.set(key, {
		abort: () => {},
		dispose: () => {},
		steer: (message) => {
			steered.push(message);
		},
	});
}

function pushParked(manager: SubagentManager, runId: string, msg: ParkedMsg): boolean {
	return (
		manager as unknown as {
			collectParked: (runId: string, msg: ParkedMsg) => boolean;
		}
	).collectParked(runId, msg);
}

describe("createRun mode semantics", () => {
	test("single agent+task becomes one queued single run with a roster", () => {
		const manager = makeManager();
		const { run, inputs } = manager.createRun({ agent: "solo", task: "do it" }, stubCtx);
		expect(run.mode).toBe("single");
		expect(run.status).toBe("queued");
		expect(run.tasks.map((t) => t.id)).toEqual(["task_1"]);
		expect(run.tasks[0]!.needs).toEqual([]);
		expect(run.tasks[0]!.runId).toBe(run.id);
		expect(run.tasks[0]!.roster).toContain("task_1 (solo)");
		expect(inputs.map((i) => i.agent)).toEqual(["solo"]);
		expect(manager.getRun(run.id)).toBe(run);
		expect(manager.hasActiveRun()).toBe(true);
	});

	test("chain mode wires each task to the previous one and fans run-wide settings out", () => {
		const manager = makeManager();
		const { run, inputs } = manager.createRun(
			{
				cwd: "/run/dir",
				maxRuntimeMs: 5000,
				chain: [
					{ agent: "a", task: "t1" },
					{ agent: "b", task: "t2", cwd: "/b" },
					{ agent: "c", task: "t3", maxRuntimeMs: 123 },
				],
			},
			stubCtx,
		);
		expect(run.mode).toBe("chain");
		expect(run.tasks.map((t) => t.id)).toEqual(["task_1", "task_2", "task_3"]);
		expect(run.tasks.map((t) => t.needs)).toEqual([[], ["task_1"], ["task_2"]]);
		expect(run.tasks.map((t) => t.cwd)).toEqual(["/run/dir", "/b", "/run/dir"]);
		expect(inputs.map((i) => i.maxRuntimeMs)).toEqual([5000, 5000, 123]);
	});

	test("tasks mode preserves declared needs edges (diamond)", () => {
		const manager = makeManager();
		const { run } = manager.createRun(
			{
				tasks: [
					{ id: "a", agent: "a", task: "t1" },
					{ id: "b", agent: "b", task: "t2", needs: ["a"] },
					{ id: "c", agent: "c", task: "t3", needs: ["a"] },
					{ id: "d", agent: "d", task: "t4", needs: ["b", "c"] },
				],
			},
			stubCtx,
		);
		expect(run.mode).toBe("parallel");
		expect(run.tasks.map((t) => t.needs)).toEqual([[], ["a"], ["a"], ["b", "c"]]);
	});

	test("concurrency clamps to 1..8 and defaults to 3", () => {
		const manager = makeManager();
		const concurrencyOf = (concurrency?: number): number =>
			manager.createRun({ agent: "a", task: "t", concurrency }, stubCtx).run.concurrency;
		expect(concurrencyOf(undefined)).toBe(3);
		expect(concurrencyOf(0)).toBe(1);
		expect(concurrencyOf(-4)).toBe(1);
		expect(concurrencyOf(5)).toBe(5);
		expect(concurrencyOf(99)).toBe(8);
	});

	test("MAX_TASKS is enforced on tasks[]", () => {
		const manager = makeManager();
		const make = (n: number) => Array.from({ length: n }, (_, i) => ({ agent: `a${i}`, task: `t${i}` }));
		expect(manager.createRun({ tasks: make(MAX_TASKS) }, stubCtx).run.tasks).toHaveLength(MAX_TASKS);
		expect(() => manager.createRun({ tasks: make(MAX_TASKS + 1) }, stubCtx)).toThrow(/Max is 16/);
	});

	test("notifyPerTask defaults to true and can be turned off", () => {
		const manager = makeManager();
		expect(manager.createRun({ agent: "a", task: "t" }, stubCtx).run.notifyPerTask).toBe(true);
		expect(manager.createRun({ agent: "a", task: "t", notifyPerTask: false }, stubCtx).run.notifyPerTask).toBe(false);
	});
});

describe("steerTask routing", () => {
	test("steers the named live child, every live child without an id, and rejects unknown runs", () => {
		const manager = makeManager();
		const { run } = manager.createRun(
			{
				tasks: [
					{ id: "live_1", agent: "a", task: "t1" },
					{ id: "live_2", agent: "b", task: "t2" },
					{ id: "idle", agent: "c", task: "t3" },
				],
			},
			stubCtx,
		);
		const steered: string[] = [];
		injectLiveChild(manager, `${run.id}:live_1`, steered);
		injectLiveChild(manager, `${run.id}:live_2`, steered);

		expect(manager.steerTask(run.id, "live_2", "just you")).toBe(true);
		expect(steered).toEqual(["just you"]);

		steered.length = 0;
		expect(manager.steerTask(run.id, undefined, "all hands")).toBe(true);
		expect(steered).toEqual(["all hands", "all hands"]);

		steered.length = 0;
		expect(manager.steerTask(run.id, "idle", "nobody listening")).toBe(true);
		expect(steered).toEqual([]);

		expect(manager.steerTask("run_missing", undefined, "hello")).toBe(false);
	});

	test("without live children an all-task steer is refused while a named id is trusted", () => {
		const manager = makeManager();
		const { run } = manager.createRun({ agent: "a", task: "t" }, stubCtx);
		expect(manager.steerTask(run.id, undefined, "hello")).toBe(false);
		expect(manager.steerTask(run.id, "task_1", "hello")).toBe(true);
	});
});

describe("awaitRun parked intercom", () => {
	test("messages collected while parked come back with the run snapshot", async () => {
		const manager = makeManager();
		const { run } = manager.createRun({ agent: "a", task: "t" }, stubCtx);
		const pending = manager.awaitRun(run.id);
		expect(
			pushParked(manager, run.id, {
				kind: "notify",
				taskId: "task_1",
				agent: "a",
				text: "halfway",
			}),
		).toBe(true);
		const awaited = await pending;
		expect(awaited?.run?.id).toBe(run.id);
		expect(awaited?.run).not.toBe(manager.getRun(run.id));
		expect(awaited?.intercom.map((msg) => msg.text)).toEqual(["halfway"]);
		expect(manager.getRun(run.id)?.awaited).toBe(true);
	});

	test("an ask collected while parked wakes the waiter immediately", async () => {
		const manager = makeManager();
		const { run } = manager.createRun({ agent: "a", task: "t" }, stubCtx);
		const pending = manager.awaitRun(run.id);
		expect(
			pushParked(manager, run.id, {
				kind: "ask",
				taskId: "task_1",
				agent: "a",
				text: "which branch?",
			}),
		).toBe(true);
		const awaited = await pending;
		expect(awaited?.intercom).toHaveLength(1);
		expect(awaited?.intercom[0]?.kind).toBe("ask");
	});

	test("parked intercom is capped at 24, and an ask displaces a non-ask message", async () => {
		const manager = makeManager();
		const { run } = manager.createRun({ agent: "a", task: "t" }, stubCtx);
		const pending = manager.awaitRun(run.id);
		for (let i = 0; i < 24; i++) {
			expect(
				pushParked(manager, run.id, {
					kind: "notify",
					taskId: "task_1",
					agent: "a",
					text: `note ${i}`,
				}),
			).toBe(true);
		}
		expect(
			pushParked(manager, run.id, {
				kind: "notify",
				taskId: "task_1",
				agent: "a",
				text: "overflow",
			}),
		).toBe(false);
		expect(
			pushParked(manager, run.id, {
				kind: "ask",
				taskId: "task_1",
				agent: "a",
				text: "which branch?",
			}),
		).toBe(true);
		const awaited = await pending;
		expect(awaited?.intercom).toHaveLength(24);
		expect(awaited?.intercom.some((msg) => msg.kind === "ask")).toBe(true);
		expect(awaited?.intercom.some((msg) => msg.text === "overflow")).toBe(false);
	});
});
