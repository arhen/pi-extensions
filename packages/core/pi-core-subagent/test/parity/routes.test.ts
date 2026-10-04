import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunSnapshot, TaskSnapshot } from "../../src/types.ts";
import { run, task, usage } from "./fixtures.ts";
import {
	createExtensionHarness,
	type ExtensionHarness,
	renderComponent,
	requireTool,
	resultText,
	runTool,
	waitFor,
} from "./harness.ts";

let h: ExtensionHarness;

beforeEach(() => {
	h = createExtensionHarness();
});
afterEach(async () => {
	await h.dispose();
});

async function seedCompletedRun(): Promise<RunSnapshot> {
	const childSession = join(h.dir, "child-task_1.jsonl");
	const failedSession = join(h.dir, "child-task_2.jsonl");
	writeFileSync(childSession, "");
	writeFileSync(failedSession, "");
	const snapshot = run({
		id: "run_done",
		createdAt: 500,
		status: "completed",
		aggregateUsage: usage({ input: 1200, output: 340, cost: 0.0123, turns: 5 }),
		tasks: [
			task({
				id: "task_1",
				runId: "run_done",
				agent: "rev",
				task: "review the parser",
				cwd: h.dir,
				status: "completed",
				finalText: "parser looks correct",
				sessionId: "sess_alpha",
				sessionFile: childSession,
				startedAt: 100,
				endedAt: 200,
				toolCalls: 4,
				usage: usage({ input: 1200, output: 340, cost: 0.0123, turns: 3 }),
			}),
			task({
				id: "task_2",
				runId: "run_done",
				agent: "writer",
				task: "write the parity fixture",
				cwd: h.dir,
				status: "failed",
				error: "429 rate limited",
				finalText: "half a patch",
				sessionId: "sess_beta",
				sessionFile: failedSession,
				branch: "subagents/run_done/task_2",
				diffStat: "2 files changed, 10 insertions(+)",
				changedFiles: ["src/a.ts", "src/b.ts"],
				isolation: "worktree",
				model: "cc/opus",
				provider: "9router",
				modelNote: "fell back to the session model",
				startedAt: 100,
				endedAt: 260,
				usage: usage({ turns: 2 }),
			}),
		],
	});
	await h.restore([snapshot]);
	return snapshot;
}

describe("subagent_status route", () => {
	test("unknown runId is an error with no run details", async () => {
		const res = await runTool(h, "subagent_status", { runId: "run_nope" });
		expect(res.isError).toBe(true);
		expect(resultText(res)).toContain("Unknown runId: run_nope");
		expect(res.details?.run).toBeUndefined();
	});

	test("a known run returns its snapshot plus live session file paths", async () => {
		const snapshot = await seedCompletedRun();
		const res = await runTool(h, "subagent_status", { runId: snapshot.id });
		expect(res.isError).toBeFalsy();
		expect(res.details.run.id).toBe(snapshot.id);
		expect(res.details.run.status).toBe("completed");
		expect(res.details.run).toEqual(snapshot);
		const text = resultText(res);
		expect(text).toContain("rev");
		expect(text).toContain("writer");
		expect(text).toContain("Live session files (tail -f to watch):");
		expect(text).toContain(`task_1 (rev): ${snapshot.tasks[0]!.sessionFile!}`);
	});

	test("returned snapshots are copies: tampering with them does not change stored state", async () => {
		await seedCompletedRun();
		const first = await runTool(h, "subagent_status", { runId: "run_done" });
		(first.details.run.tasks as TaskSnapshot[])[0]!.finalText = "TAMPERED";
		const second = await runTool(h, "subagent_status", { runId: "run_done" });
		expect((second.details.run.tasks as TaskSnapshot[])[0]!.finalText).toBe("parser looks correct");
		expect(JSON.stringify(second.details.run)).not.toContain("TAMPERED");
	});
});

describe("subagent_result route", () => {
	test("unknown runId is an error", async () => {
		const res = await runTool(h, "subagent_result", { runId: "run_nope" });
		expect(res.isError).toBe(true);
		expect(resultText(res)).toContain("Unknown runId: run_nope");
	});

	test("full result reports status, outputs, errors, worktree branch and model notes", async () => {
		const snapshot = await seedCompletedRun();
		const res = await runTool(h, "subagent_result", { runId: snapshot.id });
		expect(res.isError).toBeFalsy();
		expect(res.details.run.id).toBe(snapshot.id);
		const text = resultText(res);
		expect(text).toContain("Run run_done — completed");
		expect(text).toContain("## rev");
		expect(text).toContain("parser looks correct");
		expect(text).toContain("## writer");
		expect(text).toContain("Error: 429 rate limited");
		expect(text).toContain("Branch: subagents/run_done/task_2");
		expect(text).toContain("git merge --no-ff subagents/run_done/task_2");
		expect(text).toContain("Model: fell back to the session model");
		expect(text).toContain("3 turns");
	});

	test("taskId narrows the report to one task", async () => {
		await seedCompletedRun();
		const res = await runTool(h, "subagent_result", {
			runId: "run_done",
			taskId: "task_1",
		});
		const text = resultText(res);
		expect(text).toContain("## rev");
		expect(text).not.toContain("## writer");
		expect(text).not.toContain("429 rate limited");
	});

	test("an unknown taskId yields the run header with no task sections", async () => {
		await seedCompletedRun();
		const res = await runTool(h, "subagent_result", {
			runId: "run_done",
			taskId: "task_9",
		});
		expect(res.isError).toBeFalsy();
		expect(resultText(res)).toContain("Run run_done — completed");
		expect(resultText(res)).not.toContain("## ");
	});

	test("in-place isolation and worktree errors are surfaced", async () => {
		await h.restore([
			run({
				id: "run_iso",
				status: "completed",
				tasks: [
					task({
						id: "task_1",
						runId: "run_iso",
						agent: "editor",
						status: "completed",
						finalText: "edited",
						isolation: "in-place",
						isolationReason: "not a git repository",
					}),
					task({
						id: "task_2",
						runId: "run_iso",
						agent: "writer",
						status: "completed",
						finalText: "wrote",
						branch: "subagents/run_iso/task_2",
						worktreeError: "commit failed (uncommitted changes remain)",
					}),
				],
			}),
		]);
		const text = resultText(await runTool(h, "subagent_result", { runId: "run_iso" }));
		expect(text).toContain("Applied IN PLACE (no branch) — not a git repository");
		expect(text).toContain("Worktree: commit failed (uncommitted changes remain)");
	});

	test("rendering a result does not mutate the stored run", async () => {
		await seedCompletedRun();
		const result = await runTool(h, "subagent_result", { runId: "run_done" });
		renderComponent(
			requireTool(h, "subagent").renderResult!(result, { expanded: true }, {
				fg: (_c: string, s: string) => s,
				bold: (s: string) => s,
			} as never),
		);
		const after = await runTool(h, "subagent_status", { runId: "run_done" });
		expect((after.details.run.tasks as TaskSnapshot[])[0]!.finalText).toBe("parser looks correct");
	});
});

describe("await_subagent route", () => {
	test("unknown runId is an error", async () => {
		const res = await runTool(h, "await_subagent", { runId: "run_nope" });
		expect(res.isError).toBe(true);
		expect(resultText(res)).toContain("Unknown runId: run_nope");
	});

	test("a terminal run resolves immediately with the run summary", async () => {
		const snapshot = await seedCompletedRun();
		const started = Date.now();
		const res = await runTool(h, "await_subagent", {
			runId: snapshot.id,
			timeoutMs: 5000,
		});
		expect(Date.now() - started).toBeLessThan(1000);
		expect(res.isError).toBeFalsy();
		expect(res.details.run.id).toBe(snapshot.id);
		const text = resultText(res);
		expect(text).toContain("Run run_done: Subagents parallel finished");
		expect(text).toContain("1/2 succeeded, 1 failed");
	});
});

describe("reply_subagent route", () => {
	test("an unknown run or no pending question is an error with empty details", async () => {
		const unknown = await runTool(h, "reply_subagent", {
			runId: "run_nope",
			taskId: "task_1",
			message: "hi",
		});
		expect(unknown.isError).toBe(true);
		expect(resultText(unknown)).toContain("No pending question for run_nope/task_1.");
		expect(unknown.details).toEqual({});

		await seedCompletedRun();
		const stale = await runTool(h, "reply_subagent", {
			runId: "run_done",
			taskId: "task_1",
			message: "hi",
		});
		expect(stale.isError).toBe(true);
		expect(resultText(stale)).toContain("No pending question for run_done/task_1.");
	});
});

describe("steer_subagent route", () => {
	test("unknown runs and all-task steers with no live child report no running task", async () => {
		const unknown = await runTool(h, "steer_subagent", {
			runId: "run_nope",
			message: "keep going",
		});
		expect(unknown.isError).toBe(true);
		expect(resultText(unknown)).toContain("No running task(s) for run_nope.");
		expect(unknown.details).toEqual({});

		await seedCompletedRun();
		const all = await runTool(h, "steer_subagent", {
			runId: "run_done",
			message: "keep going",
		});
		expect(all.isError).toBe(true);
		expect(resultText(all)).toContain("No running task(s) for run_done.");
	});

	test("a named taskId is accepted as queued without re-checking the task or a live child", async () => {
		await seedCompletedRun();
		const withTask = await runTool(h, "steer_subagent", {
			runId: "run_done",
			taskId: "task_1",
			message: "keep going",
		});
		expect(withTask.isError).toBeFalsy();
		expect(resultText(withTask)).toContain("Steering message queued for run_done/task_1.");
		const missingTask = await runTool(h, "steer_subagent", {
			runId: "run_done",
			taskId: "task_9",
			message: "keep going",
		});
		expect(missingTask.isError).toBeFalsy();
	});
});

describe("resume_subagent route", () => {
	test("unknown task, completed task and never-started task are refused", async () => {
		await seedCompletedRun();
		const unknown = await runTool(h, "resume_subagent", {
			runId: "run_done",
			taskId: "task_9",
		});
		expect(unknown.isError).toBe(true);
		expect(resultText(unknown)).toContain("Unknown run_done/task_9.");

		const completed = await runTool(h, "resume_subagent", {
			runId: "run_done",
			taskId: "task_1",
		});
		expect(completed.isError).toBe(true);
		expect(resultText(completed)).toContain("task_1 completed — spawn a new task instead.");

		await h.restore([
			run({
				id: "run_never",
				status: "failed",
				tasks: [
					task({
						id: "task_1",
						runId: "run_never",
						agent: "a",
						status: "failed",
						error: "died at spawn",
					}),
				],
			}),
		]);
		const never = await runTool(h, "resume_subagent", {
			runId: "run_never",
			taskId: "task_1",
		});
		expect(never.isError).toBe(true);
		expect(resultText(never)).toContain("no session file to resume");
		expect(resultText(never)).toContain("respawn");
	});

	test("a failed task with a session file is revived and re-fails fast on an unresolvable model", async () => {
		const snapshot = await seedCompletedRun();
		const failedTask = snapshot.tasks.find((t) => t.id === "task_2")!;
		expect(existsSync(failedTask.sessionFile!)).toBe(true);

		const res = await runTool(h, "resume_subagent", {
			runId: "run_done",
			taskId: "task_2",
		});
		expect(res.isError).toBeFalsy();
		expect(resultText(res)).toContain("Resumed run_done/task_2 (writer)");
		expect(resultText(res)).toContain(`from ${failedTask.sessionFile}`);
		expect(resultText(res)).toContain("branch subagents/run_done/task_2");
		expect(resultText(res)).toContain('Next: subagent_status({ runId: "run_done" })');

		await waitFor(() => {
			try {
				const persisted = JSON.parse(readFileSync(h.sidecarFile, "utf8")) as RunSnapshot[];
				return persisted.some(
					(r) =>
						r.id === "run_done" &&
						r.status === "failed" &&
						r.tasks.some((t) => t.id === "task_2" && t.status === "failed"),
				);
			} catch {
				return false;
			}
		});

		const after = await runTool(h, "subagent_status", { runId: "run_done" });
		const taskAfter = (after.details.run.tasks as TaskSnapshot[]).find((t) => t.id === "task_2")!;
		expect(taskAfter.status).toBe("failed");
		expect(taskAfter.error ?? "").toMatch(/Model not found/);
		expect(after.details.run.status).toBe("failed");
	});
});

describe("subagent_cancel route", () => {
	test("unknown runId is an error", async () => {
		const res = await runTool(h, "subagent_cancel", { runId: "run_nope" });
		expect(res.isError).toBe(true);
		expect(resultText(res)).toContain("Unknown runId: run_nope");
	});

	test("a terminal run is a no-op and stays unchanged", async () => {
		await seedCompletedRun();
		const res = await runTool(h, "subagent_cancel", { runId: "run_done" });
		expect(res.isError).toBeFalsy();
		expect(resultText(res)).toBe("Canceled 0 tasks in run run_done.");
		expect(res.details.aborted).toBe(0);
		const after = await runTool(h, "subagent_status", { runId: "run_done" });
		expect(after.details.run.status).toBe("completed");
	});
});
