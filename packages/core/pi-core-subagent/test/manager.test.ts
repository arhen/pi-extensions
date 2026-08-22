/** Manager state transitions with a stubbed pi API — no child sessions spawned. */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "../src/manager.ts";

const stubPi = { events: { emit() {} }, sendUserMessage() {} } as unknown as ExtensionAPI;
const stubCtx = { cwd: "/tmp", hasUI: false } as unknown as ExtensionContext;

function makeManager(): SubagentManager {
	return new SubagentManager(stubPi);
}

describe("createRun", () => {
	test("mode validation rejects ambiguous params", () => {
		const m = makeManager();
		expect(() => m.createRun({ agent: "a", task: "t", tasks: [{ agent: "b", task: "t2" }] }, stubCtx)).toThrow(
			/exactly one/,
		);
	});
	test("duplicate ids rejected", () => {
		const m = makeManager();
		expect(() =>
			m.createRun(
				{
					tasks: [
						{ id: "x", agent: "a", task: "t1" },
						{ id: "x", agent: "b", task: "t2" },
					],
				},
				stubCtx,
			),
		).toThrow(/Duplicate task id/);
	});
	test("unsafe task ids are rejected (they become git refs + paths)", () => {
		const m = makeManager();
		expect(() => m.createRun({ tasks: [{ agent: "a", task: "t", id: "../evil" }] }, stubCtx)).toThrow(/Unsafe task id/);
		expect(() => m.createRun({ tasks: [{ agent: "a", task: "t", id: "a/b" }] }, stubCtx)).toThrow(/Unsafe task id/);
	});
	test("generated ids collide with explicit ones → rejected, not silently misrouted", () => {
		const m = makeManager();
		expect(() =>
			m.createRun(
				{
					tasks: [
						{ agent: "a", task: "t", id: "task_2" },
						{ agent: "b", task: "t2" },
					],
				},
				stubCtx,
			),
		).toThrow(/collides/);
	});
});

describe("cancel", () => {
	test("cancelRun on a queued run aborts every task and settles awaiters", async () => {
		const m = makeManager();
		const { run } = m.createRun(
			{
				tasks: [
					{ agent: "a", task: "t1" },
					{ agent: "b", task: "t2", needs: ["task_1"] },
				],
			},
			stubCtx,
		);
		const pending = m.awaitRun(run.id);
		const { aborted } = m.cancelRun(run.id);
		expect(aborted).toBe(2);
		const snap = await pending;
		expect(snap?.run?.status).toBe("aborted");
		expect(snap?.run?.tasks.every((t) => t.status === "aborted")).toBe(true);
		expect(snap?.run?.tasks[0]?.error).toBe("Canceled by subagent_cancel");
	});
	test("cancelRun on unknown or finished run is a no-op", () => {
		const m = makeManager();
		expect(m.cancelRun("nope")).toEqual({ aborted: 0 });
		const { run } = m.createRun({ tasks: [{ agent: "a", task: "t1" }] }, stubCtx);
		m.cancelRun(run.id);
		expect(m.cancelRun(run.id)).toEqual({ aborted: 0 }); // already terminal
	});
	test("cancelTask aborts one task, siblings stay untouched", () => {
		const m = makeManager();
		const { run } = m.createRun(
			{
				tasks: [
					{ id: "x", agent: "a", task: "t1" },
					{ id: "y", agent: "b", task: "t2" },
				],
			},
			stubCtx,
		);
		expect(m.cancelTask(run.id, "x")).toBe(true);
		expect(run.tasks.find((t) => t.id === "x")?.status).toBe("aborted");
		expect(run.tasks.find((t) => t.id === "y")?.status).toBe("queued");
		expect(m.cancelTask(run.id, "x")).toBe(false); // already terminal
	});
	test("awaitRun on a settled run resolves immediately", async () => {
		const m = makeManager();
		const { run } = m.createRun({ tasks: [{ agent: "a", task: "t1" }] }, stubCtx);
		m.cancelRun(run.id);
		const snap = await m.awaitRun(run.id);
		expect(snap?.run?.status).toBe("aborted");
	});
	test("every parked awaiter resolves on settle (no chain, no starvation)", async () => {
		const m = makeManager();
		const { run } = m.createRun({ tasks: [{ agent: "a", task: "t1" }] }, stubCtx);
		const waits = [m.awaitRun(run.id), m.awaitRun(run.id), m.awaitRun(run.id)];
		m.cancelRun(run.id);
		const settled = await Promise.all(waits);
		expect(settled.every((s) => s?.run?.status === "aborted")).toBe(true);
	});
	test("cancelRun releases a child parked on ask_parent", async () => {
		const m = makeManager();
		const { run } = m.createRun({ tasks: [{ agent: "a", task: "t1" }] }, stubCtx);
		// Stand in for a child waiting in ask_parent.
		const waiting = new Promise<string>((resolve) => {
			(m as unknown as { pendingReplies: Map<string, { resolve: (m: string) => void }> }).pendingReplies.set(
				`${run.id}:task_1`,
				{ resolve },
			);
		});
		m.cancelRun(run.id);
		expect(await waiting).toContain("canceled");
		expect(m.deliverReply(run.id, "task_1", "late answer")).toBe(false); // entry already gone
	});
});
