import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { run, task } from "./fixtures.ts";
import {
	BASELINE_OPERATIONS,
	createExtensionHarness,
	type ExtensionHarness,
	plainTheme,
	renderComponent,
	requireTool,
	runTool,
} from "./harness.ts";

const check = Value.Check as unknown as (schema: unknown, value: unknown) => boolean;

let h: ExtensionHarness;

beforeEach(() => {
	h = createExtensionHarness();
});
afterEach(async () => {
	await h.dispose();
});

function spawnCount(): number {
	return h.emitted.filter((event) => event.type === "subagent:run-created").length;
}

describe("extension surface", () => {
	test("every baseline operation is registered with a description, label and callable execute", () => {
		for (const name of BASELINE_OPERATIONS) {
			const tool = requireTool(h, name);
			expect(typeof tool.execute).toBe("function");
			expect(typeof tool.description).toBe("string");
			expect(tool.description.length).toBeGreaterThan(0);
			expect(typeof tool.label).toBe("string");
			expect(tool.label?.length).toBeGreaterThan(0);
			expect((tool.parameters as { type?: string }).type).toBe("object");
		}
	});

	test("/subagents and the peek shortcut stay registered", () => {
		expect(h.commands.has("subagents")).toBe(true);
		expect(h.shortcuts.has("ctrl+shift+a")).toBe(true);
	});

	test("runId-taking routes require a string runId", () => {
		for (const name of ["subagent_status", "subagent_cancel"]) {
			const schema = requireTool(h, name).parameters;
			expect(check(schema, { runId: "run_1" })).toBe(true);
			expect(check(schema, {})).toBe(false);
			expect(check(schema, { runId: 7 })).toBe(false);
		}
	});

	test("result, await, reply, steer and resume argument contracts", () => {
		const result = requireTool(h, "subagent_result").parameters;
		expect(check(result, { runId: "r" })).toBe(true);
		expect(check(result, { runId: "r", taskId: "t" })).toBe(true);
		expect(check(result, { taskId: "t" })).toBe(false);

		const wait = requireTool(h, "await_subagent").parameters;
		expect(check(wait, { runId: "r" })).toBe(true);
		expect(check(wait, { runId: "r", timeoutMs: 250 })).toBe(true);
		expect(check(wait, { runId: "r", timeoutMs: "250" })).toBe(false);

		const reply = requireTool(h, "reply_subagent").parameters;
		expect(check(reply, { runId: "r", taskId: "t", message: "m" })).toBe(true);
		expect(check(reply, { runId: "r", taskId: "t" })).toBe(false);
		expect(check(reply, { runId: "r", message: "m" })).toBe(false);

		const steer = requireTool(h, "steer_subagent").parameters;
		expect(check(steer, { runId: "r", message: "m" })).toBe(true);
		expect(check(steer, { runId: "r", taskId: "t", message: "m" })).toBe(true);
		expect(check(steer, { runId: "r" })).toBe(false);

		const resume = requireTool(h, "resume_subagent").parameters;
		expect(check(resume, { runId: "r", taskId: "t" })).toBe(true);
		expect(
			check(resume, {
				runId: "r",
				taskId: "t",
				message: "m",
				model: "p/m",
				thinking: "high",
			}),
		).toBe(true);
		expect(check(resume, { runId: "r" })).toBe(false);
		expect(check(resume, { runId: "r", taskId: "t", thinking: "bogus" })).toBe(false);
	});

	test("subagent arguments: single, tasks and chain shapes validate", () => {
		const schema = requireTool(h, "subagent").parameters;
		expect(check(schema, {})).toBe(true);
		expect(check(schema, { agent: "a", task: "t" })).toBe(true);
		expect(check(schema, { tasks: [{ agent: "a", task: "t" }] })).toBe(true);
		expect(
			check(schema, {
				tasks: [
					{
						agent: "a",
						task: "t",
						needs: ["task_1"],
						write: true,
						thinking: "low",
					},
				],
			}),
		).toBe(true);
		expect(check(schema, { chain: [{ agent: "a", task: "t" }] })).toBe(true);
		expect(check(schema, { tasks: [] })).toBe(true);
		expect(check(schema, { tasks: [{ agent: "a" }] })).toBe(false);
		expect(check(schema, { tasks: [{ task: "t" }] })).toBe(false);
		expect(check(schema, { tasks: [{ agent: "", task: "t" }] })).toBe(false);
		expect(check(schema, { agent: "a", task: "t", thinking: "bogus" })).toBe(false);
		expect(check(schema, { agent: "a", task: "t", concurrency: "3" })).toBe(false);
		expect(check(schema, { agent: "a", task: "t", autoAwait: "yes" })).toBe(false);
		expect(check(schema, { tasks: [{ agent: "a", task: "t", needs: "task_1" }] })).toBe(false);
	});
});

describe("subagent spawn refusals (no child is ever spawned)", () => {
	test("no mode, incomplete single and tasks+chain are refused", async () => {
		await expect(runTool(h, "subagent", {})).rejects.toThrow(/Provide one subagent mode/);
		await expect(runTool(h, "subagent", { agent: "a" })).rejects.toThrow(/agent\+task \(single\)/);
		await expect(runTool(h, "subagent", { task: "t" })).rejects.toThrow(/agent\+task \(single\)/);
		await expect(
			runTool(h, "subagent", {
				tasks: [{ agent: "a", task: "t" }],
				chain: [{ agent: "b", task: "t2" }],
			}),
		).rejects.toThrow(/not both/);
		expect(spawnCount()).toBe(0);
	});

	test("per-agent fields beside tasks/chain and unsafe ids are refused", async () => {
		await expect(
			runTool(h, "subagent", {
				write: true,
				tasks: [{ agent: "a", task: "t" }],
			}),
		).rejects.toThrow(/write describes a single agent/);
		await expect(
			runTool(h, "subagent", {
				model: "p/m",
				chain: [{ agent: "a", task: "t" }],
			}),
		).rejects.toThrow(/model describes a single agent/);
		await expect(
			runTool(h, "subagent", {
				tasks: [{ agent: "a", task: "t", id: "../evil" }],
			}),
		).rejects.toThrow(/Unsafe task id/);
		await expect(
			runTool(h, "subagent", {
				tasks: [
					{ agent: "a", task: "t", id: "same" },
					{ agent: "b", task: "t2", id: "same" },
				],
			}),
		).rejects.toThrow(/Duplicate task id/);
		await expect(
			runTool(h, "subagent", {
				tasks: [
					{ agent: "a", task: "t", id: "task_2" },
					{ agent: "b", task: "t2" },
				],
			}),
		).rejects.toThrow(/collides/);
		expect(spawnCount()).toBe(0);
	});

	test("graph, size and model errors are refused at spawn", async () => {
		await expect(
			runTool(h, "subagent", {
				tasks: [{ agent: "a", task: "t", needs: ["ghost"] }],
			}),
		).rejects.toThrow(/unknown task id: ghost/);
		await expect(
			runTool(h, "subagent", {
				tasks: [{ agent: "a", task: "t", needs: ["task_1"] }],
			}),
		).rejects.toThrow(/cannot need itself/);
		await expect(
			runTool(h, "subagent", {
				tasks: [
					{ id: "a", agent: "a", task: "t", needs: ["b"] },
					{ id: "b", agent: "b", task: "t2", needs: ["a"] },
				],
			}),
		).rejects.toThrow(/Cycle in subagent needs/);
		await expect(
			runTool(h, "subagent", {
				tasks: Array.from({ length: 17 }, (_, i) => ({
					agent: `a${i}`,
					task: `t${i}`,
				})),
			}),
		).rejects.toThrow(/Too many subagent tasks \(17\)\. Max is 16/);
		await expect(
			runTool(h, "subagent", {
				agent: "a",
				task: "t",
				model: "parity/ghost-model",
			}),
		).rejects.toThrow(/Model not found: parity\/ghost-model/);
		await expect(
			runTool(h, "subagent", {
				tasks: [{ agent: "a", task: "t", model: "parity/ghost-model" }],
			}),
		).rejects.toThrow(/Task task_1 \(a\): Model not found: parity\/ghost-model/);
		expect(spawnCount()).toBe(0);
	});
});

describe("subagent call rendering", () => {
	test("single, parallel, graph and chain calls render their mode labels", () => {
		const tool = requireTool(h, "subagent");
		const render = (args: unknown): string => renderComponent(tool.renderCall!(args, plainTheme));

		expect(render({ agent: "a", task: "t" })).toContain("single a");
		expect(
			render({
				tasks: [
					{ agent: "a", task: "t" },
					{ agent: "b", task: "t2" },
				],
			}),
		).toContain("parallel 2");
		const graph = render({
			tasks: [
				{ agent: "a", task: "t" },
				{ agent: "b", task: "t2", needs: ["task_1"] },
			],
		});
		expect(graph).toContain("graph 2");
		expect(graph).toContain("wave1[task_1] → gate → wave2[task_2]");
		expect(
			render({
				chain: [
					{ agent: "a", task: "t" },
					{ agent: "b", task: "t2" },
				],
			}),
		).toContain("chain 2");
		expect(render({ agent: "a", task: "t", autoAwait: true })).toContain("await");
		expect(render({ agent: "a", task: "t" })).toContain("bg");
	});

	test("result rendering shows progress collapsed and task detail expanded without mutating the run", () => {
		const tool = requireTool(h, "subagent");
		const snapshot = run({
			id: "run_render",
			status: "failed",
			tasks: [
				task({
					id: "task_1",
					runId: "run_render",
					agent: "rev",
					status: "completed",
					finalText: "output ok",
				}),
				task({
					id: "task_2",
					runId: "run_render",
					agent: "writer",
					status: "failed",
					error: "boom",
				}),
			],
		});
		const before = JSON.stringify(snapshot);
		const result = {
			content: [{ type: "text", text: "fallback" }],
			details: { run: snapshot },
		};

		const collapsed = renderComponent(tool.renderResult!(result, { expanded: false }, plainTheme));
		expect(collapsed).toContain("1/2 done");
		expect(collapsed).toContain("failed");

		const expanded = renderComponent(tool.renderResult!(result, { expanded: true }, plainTheme));
		expect(expanded).toContain("output ok");
		expect(expanded).toContain("boom");

		expect(JSON.stringify(snapshot)).toBe(before);
	});

	test("result rendering without run details falls back to the text content", () => {
		const tool = requireTool(h, "subagent");
		const rendered = renderComponent(
			tool.renderResult!(
				{ content: [{ type: "text", text: "no run details" }], details: {} },
				{ expanded: false },
				plainTheme,
			),
		);
		expect(rendered).toContain("no run details");
	});
});
