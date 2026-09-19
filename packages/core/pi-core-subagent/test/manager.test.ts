import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderModelCatalog } from "../src/format.ts";
import {
	chooseModel,
	listSelectableModels,
	resolveChildModel,
	SubagentManager,
	validateThinking,
} from "../src/manager.ts";

const stubPi = { events: { emit() {} }, sendUserMessage() {} } as unknown as ExtensionAPI;
/** One fixture model, so every spawn in these scheduler tests can name a model it resolves against. */
const FIXTURE_MODEL = { provider: "fixture", id: "fixture-model" };
const stubCtx = {
	cwd: "/tmp",
	hasUI: false,
	modelRegistry: {
		getAvailable: () => [FIXTURE_MODEL],
		find: (p: string, id: string) =>
			p === FIXTURE_MODEL.provider && id === FIXTURE_MODEL.id ? FIXTURE_MODEL : undefined,
	},
} as unknown as ExtensionContext;
const M = "fixture/fixture-model";

function makeManager(): SubagentManager {
	return new SubagentManager(stubPi);
}

describe("createRun", () => {
	const MODELS = [
		{ provider: "anthropic", id: "claude-sonnet-4-6", name: "Sonnet 4.6", reasoning: true, contextWindow: 200000 },
		{ provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna", reasoning: true, contextWindow: 272000 },
	];
	test("tasks[] wins over leftover top-level agent/task (models forget to drop them)", () => {
		const m = makeManager();
		const { run, inputs } = m.createRun(
			{ agent: "a", task: "t", tasks: [{ agent: "b", task: "t2", model: M }] },
			stubCtx,
		);
		expect(run.mode).toBe("parallel");
		expect(inputs.map((i) => i.agent)).toEqual(["b"]);
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
		expect(m.listRuns()).toHaveLength(0);
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
	test("a task with no model is refused — no default is applied", () => {
		const m = makeManager();
		expect(() => m.createRun({ tasks: [{ agent: "a", task: "t" }] }, stubCtx)).toThrow(
			/Task task_1 \(a\): no model specified/,
		);
		expect(m.listRuns()).toHaveLength(0);
	});
	test("single mode is refused too — the rule is not per-mode", () => {
		const m = makeManager();
		expect(() => m.createRun({ agent: "a", task: "t" }, stubCtx)).toThrow(/no model specified/);
		// The session model is never a substitute, even when the context has one.
		const withSession = {
			...(stubCtx as object),
			model: { provider: "p", id: "session" },
		} as unknown as ExtensionContext;
		expect(() => m.createRun({ agent: "a", task: "t" }, withSession)).toThrow(/no model specified/);
	});
	test("one modelless task refuses the WHOLE spawn, naming that task", () => {
		const m = makeManager();
		expect(() =>
			m.createRun(
				{
					tasks: [
						{ id: "ok", agent: "a", task: "t1", model: M },
						{ id: "bare", agent: "b", task: "t2" },
					],
				},
				stubCtx,
			),
		).toThrow(/Task bare \(b\): no model specified/);
		expect(m.listRuns()).toHaveLength(0);
	});
	test("a chain link with no model is refused as well", () => {
		const m = makeManager();
		expect(() => m.createRun({ chain: [{ agent: "a", task: "t1" }] }, stubCtx)).toThrow(/no model specified/);
		expect(m.listRuns()).toHaveLength(0);
	});
	test("the refusal names the registered providers to act on", () => {
		const m = makeManager();
		const ctx = {
			...stubCtx,
			modelRegistry: {
				getAvailable: () => MODELS,
				find: (p: string, id: string) => MODELS.find((m) => m.provider === p && m.id === id),
			},
		} as unknown as ExtensionContext;
		let message = "";
		try {
			m.createRun({ agent: "a", task: "t" }, ctx);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		// The error must name real, passable model references — not provider ids, which are not valid input.
		expect(message).toContain("anthropic/claude-sonnet-4-6");
		expect(message).toContain("openai-codex/gpt-5.6-luna");
		expect(message).toContain("subagent_models");
		// Absent registry metadata the refusal still stands — the hint is additive, never a gate.
		expect(() => m.createRun({ agent: "a", task: "t" }, stubCtx)).toThrow(/no model specified/);
	});
	test("per-agent fields beside tasks[] are refused; run-wide ones fan out", () => {
		const m = makeManager();

		expect(() => m.createRun({ write: true, tasks: [{ agent: "b", task: "t" }] }, stubCtx)).toThrow(
			/write describes a single agent/,
		);
		expect(() => m.createRun({ prompt: "p", tools: ["read"], tasks: [{ agent: "b", task: "t" }] }, stubCtx)).toThrow(
			/prompt, tools describe a single agent/,
		);

		const { inputs } = m.createRun(
			{
				cwd: "/run/wide",
				maxRuntimeMs: 1234,
				tasks: [
					{ agent: "a", task: "t1", model: M },
					{ agent: "b", task: "t2", cwd: "/per/task", maxRuntimeMs: 99, model: M },
				],
			},
			stubCtx,
		);
		expect(inputs.map((i) => i.cwd)).toEqual(["/run/wide", "/per/task"]);
		expect(inputs.map((i) => i.maxRuntimeMs)).toEqual([1234, 99]);

		expect(m.createRun({ tasks: [{ agent: "b", task: "t", write: true, model: M }] }, stubCtx).run.mode).toBe(
			"parallel",
		);

		expect(
			m.createRun({ agent: "a", task: "t", tasks: [{ agent: "b", task: "t2", model: M }] }, stubCtx).run.mode,
		).toBe("parallel");
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
					{ agent: "a", task: "t1", model: M },
					{ agent: "b", task: "t2", needs: ["task_1"], model: M },
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
		const { run } = m.createRun({ tasks: [{ agent: "a", task: "t1", model: M }] }, stubCtx);
		m.cancelRun(run.id);
		expect(m.cancelRun(run.id)).toEqual({ aborted: 0 });
	});
	test("cancelTask aborts one task, siblings stay untouched", () => {
		const m = makeManager();
		const { run } = m.createRun(
			{
				tasks: [
					{ id: "x", agent: "a", task: "t1", model: M },
					{ id: "y", agent: "b", task: "t2", model: M },
				],
			},
			stubCtx,
		);
		expect(m.cancelTask(run.id, "x")).toBe(true);
		expect(run.tasks.find((t) => t.id === "x")?.status).toBe("aborted");
		expect(run.tasks.find((t) => t.id === "y")?.status).toBe("queued");
		expect(m.cancelTask(run.id, "x")).toBe(false);
	});
	test("awaitRun on a settled run resolves immediately", async () => {
		const m = makeManager();
		const { run } = m.createRun({ tasks: [{ agent: "a", task: "t1", model: M }] }, stubCtx);
		m.cancelRun(run.id);
		const snap = await m.awaitRun(run.id);
		expect(snap?.run?.status).toBe("aborted");
	});
	test("every parked awaiter resolves on settle (no chain, no starvation)", async () => {
		const m = makeManager();
		const { run } = m.createRun({ tasks: [{ agent: "a", task: "t1", model: M }] }, stubCtx);
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
		m.createRun({ tasks: [{ agent: "a", task: "keep me", model: M }] }, ctx);
		(m as unknown as { persist: (c: ExtensionContext) => void }).persist(ctx);
		await new Promise((r) => setTimeout(r, 50));
		const saved = existsSync(sidecar) ? readFileSync(sidecar, "utf8") : "";
		m.clearRuns();

		(m as unknown as { persist: (c: ExtensionContext) => void }).persist(ctx);
		await new Promise((r) => setTimeout(r, 50));
		if (saved) expect(readFileSync(sidecar, "utf8")).toBe(saved);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
		rmSync(dir, { recursive: true, force: true });
	});
	test("a delivered reply is consumed once (identity-tagged entry clears itself)", async () => {
		const m = makeManager();
		const { run } = m.createRun({ tasks: [{ agent: "a", task: "t1", model: M }] }, stubCtx);

		const waiting = (
			m as unknown as { awaitParentReply: (r: string, t: string, ms?: number) => Promise<string> }
		).awaitParentReply(run.id, "task_1");
		expect(m.deliverReply(run.id, "task_1", "answer one")).toBe(true);
		expect(await waiting).toBe("answer one");
		expect(m.deliverReply(run.id, "task_1", "answer two")).toBe(false);
	});
	test("clearRuns releases parked awaits instead of hanging them", async () => {
		const m = makeManager();
		const { run } = m.createRun({ tasks: [{ agent: "a", task: "t1", model: M }] }, stubCtx);
		const waiting = m.awaitRun(run.id);
		m.clearRuns();
		const settled = await waiting;
		expect(settled?.run).toBeDefined();
	});
	test("cancelRun releases a child parked on ask_parent", async () => {
		const m = makeManager();
		const { run } = m.createRun({ tasks: [{ agent: "a", task: "t1", model: M }] }, stubCtx);

		const waiting = new Promise<string>((resolve) => {
			(m as unknown as { pendingReplies: Map<string, { resolve: (m: string) => void }> }).pendingReplies.set(
				`${run.id}:task_1`,
				{ resolve },
			);
		});
		m.cancelRun(run.id);
		expect(await waiting).toContain("canceled");
		expect(m.deliverReply(run.id, "task_1", "late answer")).toBe(false);
	});
});

describe("tool precedence (issue #3)", () => {
	const src = readFileSync(new URL("../src/manager.ts", import.meta.url), "utf8");
	test("explicit tools:/write: win over a matched file's tools; file only narrows the default", () => {
		expect(src).toMatch(/const explicitTools = input\.tools \?\? \(input\.write \? WRITE_TOOLS : undefined\);/);
		expect(src).toMatch(/const baseTools = explicitTools \?\? \(fileTools\?\.length \? fileTools : allowedTools\);/);
	});
	test("an overridden file's tools are surfaced on the task, not silently dropped", () => {
		expect(src).toMatch(/task\.toolsNote = `explicit tools overrode agent-file tools/);
	});
});

describe("resumeTask", () => {
	function seeded(status: "failed" | "completed" | "running", sessionFile?: string) {
		const m = makeManager();
		const { run } = m.createRun({ agent: "a", task: "t", model: M }, stubCtx);
		const task = run.tasks[0]!;
		task.status = status;
		task.sessionFile = sessionFile;
		run.status = status === "running" ? "running" : status;
		return { m, run, task };
	}
	test("a resume with no recorded model is refused unless one is supplied", () => {
		// Resume starts a run through runChild, not createRun, so it needs the same contract:
		// without it a settled task silently inherited the session model at resolveChildModel.
		const dir = mkdtempSync(join(tmpdir(), "resume-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(file, "");
		const { m, run, task } = seeded("failed", file);
		task.model = undefined;
		const res = m.resumeTask(run.id, task.id, stubCtx);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.reason).toMatch(/no model recorded/);
			expect(res.reason).toContain("subagent_models");
		}
		rmSync(dir, { recursive: true, force: true });
	});
	test("a resume that supplies a model is allowed even when none was recorded", () => {
		const dir = mkdtempSync(join(tmpdir(), "resume2-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(file, "");
		const { m, run, task } = seeded("failed", file);
		task.model = undefined;
		const res = m.resumeTask(run.id, task.id, stubCtx, { model: M });
		expect(res.ok).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});
	test("refuses never-started task (no session file) — respawn is the right move", () => {
		const { m, run, task } = seeded("failed");
		const res = m.resumeTask(run.id, task.id, stubCtx);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toMatch(/no session file/);
	});
	test("refuses completed task and still-running run", () => {
		const dir = mkdtempSync(join(tmpdir(), "resume-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(file, "");
		const done = seeded("completed", file);
		expect(done.m.resumeTask(done.run.id, done.task.id, stubCtx).ok).toBe(false);
		const live = seeded("running", file);
		expect(live.m.resumeTask(live.run.id, live.task.id, stubCtx).ok).toBe(false);
		expect(makeManager().resumeTask("run_x", "task_1", stubCtx).ok).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});
	test("failed task with a session file flips to queued and the run reopens", async () => {
		const dir = mkdtempSync(join(tmpdir(), "resume-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(file, "");
		const { m, run, task } = seeded("failed", file);
		task.error = "usage limit";
		task.tools = ["read", "bash", "ask_parent"];
		const res = m.resumeTask(run.id, task.id, { ...stubCtx, modelRegistry: undefined } as unknown as ExtensionContext);
		expect(res.ok).toBe(true);
		expect(run.status).toBe("running");
		expect(["queued", "starting", "running", "failed"]).toContain(task.status);
		expect(task.error === undefined || task.error !== "usage limit").toBe(true);
		await new Promise((r) => setTimeout(r, 300));
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("listSelectableModels", () => {
	const withRegistry = (models: any[], extra: Record<string, unknown> = {}) =>
		({
			cwd: "/tmp",
			hasUI: false,
			modelRegistry: {
				getAvailable: () => models,
				find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
				...extra,
			},
		}) as unknown as ExtensionContext;

	test("every listed reference is exactly what resolveChildModel accepts", () => {
		const models = [
			{ provider: "anthropic", id: "claude-sonnet-4-6", name: "Sonnet 4.6", reasoning: true, contextWindow: 200000 },
		];
		const catalog = listSelectableModels(withRegistry(models));
		expect(catalog.models.map((m) => m.reference)).toEqual(["anthropic/claude-sonnet-4-6"]);
		// The catalog's promise is that a listed reference resolves — prove it for real, not by shape.
		expect(resolveChildModel(withRegistry(models), catalog.models[0]!.reference)).toBe(models[0] as never);
	});
	test("thinking levels are the model's real ones, not the full enum", () => {
		// `null` marks a level unsupported; an absent key keeps the provider default (supported).
		const thinkingLevelMap: Record<string, string | null> = {
			off: null,
			minimal: null,
			low: null,
			medium: "medium-reasoning",
			high: null,
			xhigh: null,
			max: null,
		};
		const catalog = listSelectableModels(
			withRegistry([
				{ provider: "p", id: "reasoning", name: "R", reasoning: true, contextWindow: 1, thinkingLevelMap },
				{ provider: "p", id: "plain", name: "P", reasoning: false, contextWindow: 1 },
			]),
		);
		expect(catalog.models[0]!.thinkingLevels).toEqual(["off", "medium"]);
		expect(catalog.models[1]!.thinkingLevels).toEqual(["off"]);
	});
	test("an empty registry reports unavailability instead of an empty catalog", () => {
		expect(listSelectableModels(withRegistry([])).unavailable).toBe("no model has usable credentials");
		expect(listSelectableModels({ cwd: "/tmp", hasUI: false } as unknown as ExtensionContext).unavailable).toBe(
			"this context exposes no model registry",
		);
	});
	test("a throwing registry degrades to unavailable rather than crashing the spawn", () => {
		const catalog = listSelectableModels(
			withRegistry([], {
				getAvailable: () => {
					throw new Error("registry exploded");
				},
			}),
		);
		expect(catalog.models).toEqual([]);
		expect(catalog.unavailable).toBe("registry exploded");
	});
});

describe("catalog truthfulness (regressions)", () => {
	const ctxFor = (models: any[]) =>
		({
			cwd: "/tmp",
			hasUI: false,
			model: undefined,
			modelRegistry: {
				getAvailable: () => models,
				find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
			},
		}) as unknown as ExtensionContext;

	test("every advertised reference resolves back to the model it describes", () => {
		// Model B's bare id "a/m" shadows model A's "a/m" reference: resolveChildModel checks bare ids
		// first, so a naive provider/id string would silently select B while advertising A.
		const A = { provider: "a", id: "m", name: "A/M", reasoning: true, contextWindow: 100 };
		const B = { provider: "b", id: "a/m", name: "B/AM", reasoning: false, contextWindow: 100 };
		const ctx = ctxFor([A, B]);
		const catalog = listSelectableModels(ctx);

		for (const m of catalog.models) {
			const resolved = resolveChildModel(ctx, m.reference)!;
			expect({ provider: resolved.provider, id: resolved.id }).toEqual({ provider: m.provider, id: m.id });
		}
		// The shadowed reference is withheld and explained, not silently mislabelled.
		expect(catalog.models.map((m) => m.reference)).not.toContain("a/m");
		expect(catalog.ambiguous).toContain("a/m");
		expect(catalog.reason).toContain("a/m");
	});

	test("an advertised model's thinking claim matches what the spawn will accept", () => {
		const models = [
			{
				provider: "p",
				id: "reasoner",
				name: "R",
				reasoning: true,
				contextWindow: 100,
				thinkingLevelMap: { off: null, minimal: null, low: null, medium: "m", high: "h", xhigh: null, max: null },
			},
			{ provider: "p", id: "plain", name: "P", reasoning: false, contextWindow: 100 },
		];
		const ctx = ctxFor(models);
		for (const m of listSelectableModels(ctx).models) {
			const resolved = resolveChildModel(ctx, m.reference) as never;
			// The catalog's claim is the contract: a level it lists must be accepted, and a model it
			// marks non-reasoning must reject the level instead of silently ignoring it.
			for (const level of m.thinkingLevels) expect(() => validateThinking(resolved, level)).not.toThrow();
			if (!m.reasoning) expect(() => validateThinking(resolved, "medium")).toThrow(/does not support thinking/);
		}
	});

	test("a model missing contextWindow does not crash the real catalog renderer", () => {
		const ctx = ctxFor([{ provider: "a", id: "m", name: "M", reasoning: true }]);
		const catalog = listSelectableModels(ctx);
		expect(catalog.models[0]!.contextWindow).toBe(0);
		// Invoke the actual renderer the tool returns, not a copy of its interpolation.
		const out = renderModelCatalog(catalog);
		expect(out.content[0]!.text).toContain("context window unreported");
	});

	test("the catalog never advertises a thinking level the runtime would silently clamp", () => {
		// reasoning:true with no thinkingLevelMap: pi reports xhigh/max unsupported and clampThinkingLevel
		// downgrades an unmapped max to high, so advertising max would promise a level never honored.
		const ctx = ctxFor([{ provider: "p", id: "no-map", name: "No Map", reasoning: true, contextWindow: 1 }]);
		const catalog = listSelectableModels(ctx);
		const advertised = catalog.models[0]!.thinkingLevels;
		expect(advertised).not.toContain("max");
		expect(advertised).not.toContain("xhigh");
		// The catalog's list must equal pi's own resolver output, not a parallel rule.
		expect(advertised).toEqual([
			...getSupportedThinkingLevels({ provider: "p", id: "no-map", reasoning: true } as never),
		]);
		// And a level the catalog omits must be rejected rather than silently downgraded.
		expect(() => validateThinking({ provider: "p", id: "no-map", reasoning: true } as never, "max")).toThrow(
			/not supported/,
		);
	});

	test("an explicitly mapped xhigh/max is advertised and accepted", () => {
		const ctx = ctxFor([
			{
				provider: "p",
				id: "mapped",
				name: "Mapped",
				reasoning: true,
				contextWindow: 1,
				thinkingLevelMap: { max: "maximal", xhigh: "xtra" },
			},
		]);
		const advertised = listSelectableModels(ctx).models[0]!.thinkingLevels;
		expect(advertised).toContain("max");
		expect(advertised).toContain("xhigh");
		expect(() =>
			validateThinking(
				{ provider: "p", id: "mapped", reasoning: true, thinkingLevelMap: { max: "maximal" } } as never,
				"max",
			),
		).not.toThrow();
	});
});

describe("registry faults are not misreported as collisions", () => {
	test("an empty catalog throws, because the SDK drops a returned isError", () => {
		// pi-agent-core returns {isError:false} for any execute that does not throw, so a returned
		// flag would present an unusable catalog as success. The renderer must throw instead.
		expect(() => renderModelCatalog({ models: [], unavailable: "no model has usable credentials" })).toThrow(
			/no model has usable credentials/,
		);
		expect(() => renderModelCatalog({ models: [] })).toThrow(/registry returned no models/);
	});

	test("a registry fault is reported as unavailable, not as a name collision", () => {
		// A registry whose listing throws is a registry fault. It must never be presented as an
		// empty catalog or as a provider/id collision, because the caller's fix differs for each.
		const ctx = {
			cwd: "/tmp",
			hasUI: false,
			modelRegistry: {
				getAvailable: () => {
					throw new Error("registry exploded");
				},
				find: () => undefined,
			},
		} as unknown as ExtensionContext;
		const catalog = listSelectableModels(ctx);
		expect(catalog.models).toEqual([]);
		expect(catalog.unavailable).toBe("registry exploded");
		expect(catalog.ambiguous).toBeUndefined();
		// The fault reaches the agent as a thrown error, since the SDK drops a returned isError.
		expect(() => renderModelCatalog(catalog)).toThrow(/registry exploded/);
	});
});

describe("model choice has one owner (DRY)", () => {
	test("an agent file's model wins over the inline one, and names its source", () => {
		expect(chooseModel({ model: "from/file", path: "/a/b.md" }, "from/inline")).toEqual({
			requested: "from/file",
			sourceFile: "/a/b.md",
		});
	});
	test("with no file model, the inline value stands and no source is claimed", () => {
		expect(chooseModel({ path: "/a/b.md" }, "from/inline")).toEqual({ requested: "from/inline" });
		expect(chooseModel(undefined, "from/inline")).toEqual({ requested: "from/inline" });
	});
	test("blank values are not treated as a supplied model", () => {
		expect(chooseModel({ model: "   " }, undefined).requested).toBeUndefined();
		expect(chooseModel(undefined, "").requested).toBe("");
	});
	test("the pre-creation check and the spawn resolve the same rule", () => {
		// Both call sites must agree on whether a model was supplied; a second copy of the
		// precedence rule is what let resume silently bypass the required-model contract.
		const src = readFileSync(new URL("../src/manager.ts", import.meta.url), "utf8");
		expect(src).not.toMatch(/file\?\.model \?\? input\.model/);
		expect(src.match(/chooseModel\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3); // decl + 2 call sites
	});
});
