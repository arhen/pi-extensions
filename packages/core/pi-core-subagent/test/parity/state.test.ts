import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunSnapshot, TaskSnapshot } from "../../src/types.ts";
import { run, task, usage } from "./fixtures.ts";
import { createExtensionHarness, type ExtensionHarness, resultText, runTool } from "./harness.ts";

let h: ExtensionHarness;

beforeEach(() => {
	h = createExtensionHarness();
});
afterEach(async () => {
	await h.dispose();
});

function restoredCounts(): number[] {
	return h.emitted
		.filter((event) => event.type === "subagent:runs-restored")
		.map((event) => Number(event.payload.count));
}

async function statusOf(runId: string): Promise<RunSnapshot> {
	const res = await runTool(h, "subagent_status", { runId });
	return res.details.run as RunSnapshot;
}

describe("sidecar restoration", () => {
	test("terminal runs survive a reload intact", async () => {
		const completed = run({
			id: "run_completed",
			createdAt: 200,
			status: "completed",
			aggregateUsage: usage({ turns: 2 }),
			endedAt: 900,
			tasks: [
				task({
					id: "task_1",
					runId: "run_completed",
					agent: "a",
					status: "completed",
					finalText: "done",
					endedAt: 900,
				}),
			],
		});
		const aborted = run({
			id: "run_aborted",
			createdAt: 100,
			status: "aborted",
			endedAt: 800,
			tasks: [
				task({
					id: "task_1",
					runId: "run_aborted",
					agent: "b",
					status: "aborted",
					error: "Canceled by subagent_cancel",
					endedAt: 800,
				}),
			],
		});
		await h.restore([completed, aborted]);
		expect(restoredCounts()).toEqual([2]);
		expect(await statusOf("run_completed")).toEqual(completed);
		expect(await statusOf("run_aborted")).toEqual(aborted);
	});

	test("interrupted tasks abort with their session file and prior error preserved", async () => {
		const sessionFile = join(h.dir, "interrupted.jsonl");
		writeFileSync(sessionFile, "");
		const live = run({
			id: "run_live",
			status: "running",
			createdAt: 300,
			tasks: [
				task({
					id: "task_1",
					runId: "run_live",
					agent: "a",
					status: "running",
					sessionFile,
					endedAt: undefined,
				}),
				task({
					id: "task_2",
					runId: "run_live",
					agent: "b",
					status: "awaiting_parent",
					error: "waiting for an answer",
				}),
				task({ id: "task_3", runId: "run_live", agent: "c", status: "queued" }),
			],
		});
		await h.restore([live]);
		const restored = await statusOf("run_live");
		expect(restored.status).toBe("aborted");
		expect(typeof restored.endedAt).toBe("number");
		const tasks = restored.tasks as TaskSnapshot[];
		expect(tasks.map((t) => t.status)).toEqual(["aborted", "aborted", "aborted"]);
		expect(tasks[0]!.error).toBe("Interrupted by session reload");
		expect(tasks[0]!.sessionFile).toBe(sessionFile);
		expect(tasks[1]!.error).toBe("waiting for an answer");
		expect(tasks[2]!.error).toBe("Interrupted by session reload");
	});

	test("an ask pending at reload is not resurrected: reply fails and await returns", async () => {
		await h.restore([
			run({
				id: "run_ask",
				status: "running",
				tasks: [
					task({
						id: "task_1",
						runId: "run_ask",
						agent: "asker",
						status: "awaiting_parent",
					}),
				],
			}),
		]);
		const reply = await runTool(h, "reply_subagent", {
			runId: "run_ask",
			taskId: "task_1",
			message: "answer",
		});
		expect(reply.isError).toBe(true);
		expect(resultText(reply)).toContain("No pending question for run_ask/task_1.");

		const awaited = await runTool(h, "await_subagent", {
			runId: "run_ask",
			timeoutMs: 100,
		});
		expect(awaited.isError).toBeFalsy();
		expect(awaited.details.run.status).toBe("aborted");
	});

	test("non-terminal run statuses are recomputed from task outcomes", async () => {
		await h.restore([
			run({
				id: "run_all_done",
				createdAt: 300,
				status: "queued",
				tasks: [task({ id: "task_1", runId: "run_all_done", status: "completed" })],
			}),
			run({
				id: "run_failed",
				createdAt: 200,
				status: "queued",
				tasks: [
					task({
						id: "task_1",
						runId: "run_failed",
						status: "failed",
						error: "boom",
					}),
				],
			}),
			run({
				id: "run_stopped",
				createdAt: 100,
				status: "running",
				tasks: [
					task({
						id: "task_1",
						runId: "run_stopped",
						status: "aborted",
						error: "stopped",
					}),
				],
			}),
		]);
		expect((await statusOf("run_all_done")).status).toBe("completed");
		expect((await statusOf("run_failed")).status).toBe("failed");
		expect((await statusOf("run_stopped")).status).toBe("aborted");
	});

	test("corrupt or non-array sidecars are ignored, not fatal", async () => {
		h.writeSidecar("{ this is not json");
		await h.startSession();
		expect(restoredCounts()).toEqual([]);
		expect((await runTool(h, "subagent_status", { runId: "run_x" })).isError).toBe(true);

		h.writeSidecar(JSON.stringify({ runs: [] }));
		await h.startSession();
		expect(restoredCounts()).toEqual([]);
	});

	test("stale *.tmp sidecar siblings are swept on restore", async () => {
		const stale = `${h.sidecarFile}.999.deadbe.1.tmp`;
		const unrelated = join(h.dir, "other.tmp");
		writeFileSync(stale, "partial write");
		writeFileSync(unrelated, "keep me");
		await h.restore([run({ id: "run_1", tasks: [task({ id: "task_1", runId: "run_1" })] })]);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(unrelated)).toBe(true);
	});

	test("restoring the same runs twice does not duplicate them", async () => {
		const snapshot = run({
			id: "run_once",
			tasks: [task({ id: "task_1", runId: "run_once" })],
		});
		await h.restore([snapshot]);
		await h.restore([snapshot]);
		expect(restoredCounts()).toEqual([1]);
		expect((await statusOf("run_once")).id).toBe("run_once");
	});

	test("duplicate ids inside one sidecar keep the first entry", async () => {
		const first = run({
			id: "run_dup",
			createdAt: 10,
			tasks: [task({ id: "task_1", runId: "run_dup", agent: "first" })],
		});
		const second = run({
			id: "run_dup",
			createdAt: 20,
			tasks: [task({ id: "task_2", runId: "run_dup", agent: "second" })],
		});
		await h.restore([first, second]);
		expect(restoredCounts()).toEqual([1]);
		const restored = await statusOf("run_dup");
		expect(restored.createdAt).toBe(10);
		expect((restored.tasks as TaskSnapshot[]).map((t) => t.agent)).toEqual(["first"]);
	});

	test("session shutdown empties this session's runs", async () => {
		await h.restore([run({ id: "run_bye", tasks: [task({ id: "task_1", runId: "run_bye" })] })]);
		await h.invoke("session_shutdown");
		expect((await runTool(h, "subagent_status", { runId: "run_bye" })).isError).toBe(true);
		expect((await runTool(h, "subagent_result", { runId: "run_bye" })).isError).toBe(true);
	});
});

describe("/subagents command over restored state", () => {
	test("empty state says so", async () => {
		const command = h.commands.get("subagents");
		expect(command).toBeDefined();
		await command!.handler("", h.ctx());
		expect(h.notifications.map((n) => n.message).join("\n")).toContain("No subagent runs in this session.");
	});

	test("listing shows restored runs newest-first", async () => {
		const oldest = run({
			id: "run_old",
			createdAt: 100,
			tasks: [
				task({
					id: "task_1",
					runId: "run_old",
					agent: "oldest",
					status: "completed",
				}),
			],
		});
		const newest = run({
			id: "run_new",
			createdAt: 200,
			tasks: [
				task({
					id: "task_1",
					runId: "run_new",
					agent: "newest",
					status: "completed",
				}),
			],
		});
		await h.restore([oldest, newest]);
		h.notifications.length = 0;
		await h.commands.get("subagents")!.handler("", h.ctx());
		const listing = h.notifications
			.filter((n) => n.level === "info")
			.map((n) => n.message)
			.join("\n");
		expect(listing).toContain("newest");
		expect(listing).toContain("oldest");
		expect(listing.indexOf("newest")).toBeLessThan(listing.indexOf("oldest"));
	});
});
