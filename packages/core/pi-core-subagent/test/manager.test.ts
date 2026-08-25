/** Manager state transitions with a stubbed pi API — no child sessions spawned. */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "../src/manager.ts";

const stubPi = { events: { emit() {} }, sendUserMessage() {} } as unknown as ExtensionAPI;
const stubCtx = { cwd: "/tmp", hasUI: false } as unknown as ExtensionContext;

function makeManager(): SubagentManager {
	return new SubagentManager(stubPi);
}

describe("createRun", () => {
	test("tasks[] wins over leftover top-level agent/task (models forget to drop them)", () => {
		const m = makeManager();
		const { run, inputs } = m.createRun({ agent: "a", task: "t", tasks: [{ agent: "b", task: "t2" }] }, stubCtx);
		expect(run.mode).toBe("parallel");
		expect(inputs.map((i) => i.agent)).toEqual(["b"]); // the stray single is ignored, not merged
	});
	test("tasks + chain together is still refused (genuinely ambiguous)", () => {
		const m = makeManager();
		expect(() =>
			m.createRun({ tasks: [{ agent: "a", task: "t" }], chain: [{ agent: "b", task: "t2" }] }, stubCtx),
		).toThrow(/not both/);
	});
	test("no mode at all is refused with the full list of shapes", () => {
		const m = makeManager();
		expect(() => m.createRun({ agent: "a" }, stubCtx)).toThrow(/agent\+task \(single\)/);
	});
	test("an unresolvable model refuses the SPAWN, no run is created", () => {
		const m = makeManager();
		const ctx = {
			cwd: "/tmp",
			hasUI: false,
			modelRegistry: { getAvailable: () => [], find: () => undefined },
		} as unknown as ExtensionContext;
		expect(() => m.createRun({ tasks: [{ agent: "a", task: "t", model: "nope/not-a-model" }] }, ctx)).toThrow(
			/Model not found: nope\/not-a-model/,
		);
		expect(m.listRuns()).toHaveLength(0); // nothing half-created
	});
	test("a bad model in ONE task refuses the whole spawn, naming that task", () => {
		const m = makeManager();
		const ctx = {
			cwd: "/tmp",
			hasUI: false,
			modelRegistry: {
				getAvailable: () => [{ id: "good", provider: "p" }],
				find: () => undefined,
			},
		} as unknown as ExtensionContext;
		expect(() =>
			m.createRun(
				{
					tasks: [
						{ id: "ok", agent: "a", task: "t1", model: "good" },
						{ id: "bad", agent: "b", task: "t2", model: "missing" },
					],
				},
				ctx,
			),
		).toThrow(/Task bad \(b\): Model not found: missing/);
		expect(m.listRuns()).toHaveLength(0);
	});
	test("per-agent fields beside tasks[] are refused; run-wide ones fan out", () => {
		const m = makeManager();
		// write:true next to tasks[] produced read-only children that reported they
		// "cannot edit files", with nothing explaining why.
		expect(() => m.createRun({ write: true, tasks: [{ agent: "b", task: "t" }] }, stubCtx)).toThrow(
			/write describes a single agent/,
		);
		expect(() => m.createRun({ prompt: "p", tools: ["read"], tasks: [{ agent: "b", task: "t" }] }, stubCtx)).toThrow(
			/prompt, tools describe a single agent/,
		);
		// cwd + maxRuntimeMs are meaningful run-wide: they become per-task defaults,
		// and a per-task value still wins.
		const { inputs } = m.createRun(
			{
				cwd: "/run/wide",
				maxRuntimeMs: 1234,
				tasks: [
					{ agent: "a", task: "t1" },
					{ agent: "b", task: "t2", cwd: "/per/task", maxRuntimeMs: 99 },
				],
			},
			stubCtx,
		);
		expect(inputs.map((i) => i.cwd)).toEqual(["/run/wide", "/per/task"]);
		expect(inputs.map((i) => i.maxRuntimeMs)).toEqual([1234, 99]);
		// Per-item is the correct shape and still works.
		expect(m.createRun({ tasks: [{ agent: "b", task: "t", write: true }] }, stubCtx).run.mode).toBe("parallel");
		// Leftover agent/task stay tolerated — they carry no capability.
		expect(m.createRun({ agent: "a", task: "t", tasks: [{ agent: "b", task: "t2" }] }, stubCtx).run.mode).toBe(
			"parallel",
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
	test("a late persist after clearRuns cannot erase the sidecar", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sidecar-"));
		const sessionFile = join(dir, "s.jsonl");
		const sidecar = join(dir, "s.subagents.json");
		writeFileSync(sessionFile, "");
		const ctx = { cwd: dir, hasUI: false, sessionFile } as unknown as ExtensionContext;
		const m = makeManager();
		m.createRun({ tasks: [{ agent: "a", task: "keep me" }] }, ctx);
		(m as unknown as { persist: (c: ExtensionContext) => void }).persist(ctx);
		await new Promise((r) => setTimeout(r, 50));
		const saved = existsSync(sidecar) ? readFileSync(sidecar, "utf8") : "";
		m.clearRuns();
		// The deferred background rejection handler fires after shutdown.
		(m as unknown as { persist: (c: ExtensionContext) => void }).persist(ctx);
		await new Promise((r) => setTimeout(r, 50));
		if (saved) expect(readFileSync(sidecar, "utf8")).toBe(saved); // not overwritten with []
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0); // no tmp leak
		rmSync(dir, { recursive: true, force: true });
	});
	test("a delivered reply is consumed once (identity-tagged entry clears itself)", async () => {
		const m = makeManager();
		const { run } = m.createRun({ tasks: [{ agent: "a", task: "t1" }] }, stubCtx);
		// Real entry, created the way onAskParent does it.
		const waiting = (
			m as unknown as { awaitParentReply: (r: string, t: string, ms?: number) => Promise<string> }
		).awaitParentReply(run.id, "task_1");
		expect(m.deliverReply(run.id, "task_1", "answer one")).toBe(true);
		expect(await waiting).toBe("answer one");
		expect(m.deliverReply(run.id, "task_1", "answer two")).toBe(false); // entry gone, no double-answer
	});
	test("clearRuns releases parked awaits instead of hanging them", async () => {
		const m = makeManager();
		const { run } = m.createRun({ tasks: [{ agent: "a", task: "t1" }] }, stubCtx);
		const waiting = m.awaitRun(run.id);
		m.clearRuns();
		const settled = await waiting; // would hang before the fix
		expect(settled?.run).toBeDefined();
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
