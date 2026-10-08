import { describe, expect, test } from "bun:test";
import { applyTaskMutation, buildToolResult } from "../src/state.ts";
import { EMPTY_STATE, type TaskMutationParams, type TaskOp, type TaskStatus } from "../src/types.ts";

describe("initial create status", () => {
	test("omitted status still defaults to pending", () => {
		const result = applyTaskMutation(EMPTY_STATE, "create", { subject: "Plan work" });
		expect(result.op.kind).toBe("create");
		expect(result.state.tasks[0]!.status).toBe("pending");
	});

	for (const status of ["pending", "in_progress", "completed"] as const) {
		test(`accepts explicit ${status} and reports the actual status`, () => {
			const params = {
				subject: "Investigate failure",
				status,
				activeForm: "investigating failure",
				description: "Trace validation",
				owner: "agent",
				metadata: { source: "regression" },
			};
			const result = applyTaskMutation(EMPTY_STATE, "create", params);
			expect(result.op).toEqual({ kind: "create", taskId: 1 });
			expect(result.state.tasks[0]).toEqual({ id: 1, ...params });
			expect(result.state.nextId).toBe(2);
			const output = buildToolResult("create", params, result.state, result.op);
			expect(output.content[0]!.text).toBe(`Created #1: Investigate failure (${status})`);
			expect(output.isError).not.toBe(true);
		});
	}

	for (const status of ["deleted", "cancelled", "", null]) {
		test(`rejects invalid initial status ${JSON.stringify(status)} without mutation`, () => {
			const result = applyTaskMutation(EMPTY_STATE, "create", {
				subject: "Invalid status",
				status: status as TaskStatus,
			});
			expect(result.state).toBe(EMPTY_STATE);
			expect(result.op.kind).toBe("error");
			expect(result.op.kind === "error" && result.op.message).toContain(
				"create status must be pending, in_progress, or completed",
			);
		});
	}

	for (const field of ["id", "addBlockedBy", "removeBlockedBy", "includeDeleted"]) {
		test(`still rejects ${field} with actionable feedback`, () => {
			const params: TaskMutationParams = { subject: "Invalid field", status: "in_progress" };
			params[field] = field === "id" ? 1 : field === "includeDeleted" ? false : [];
			const result = applyTaskMutation(EMPTY_STATE, "create", params);
			expect(result.state).toBe(EMPTY_STATE);
			expect(result.op.kind === "error" && result.op.message).toContain(`remove: ${field}`);
			const output = buildToolResult("create", params, result.state, result.op);
			expect(output.isError).toBe(true);
			expect(output.details.error).toContain(`remove: ${field}`);
		});
	}

	test("completed tasks retain normal transition restrictions", () => {
		const created = applyTaskMutation(EMPTY_STATE, "create", { subject: "Done", status: "completed" });
		const result = applyTaskMutation(created.state, "update", { id: 1, status: "in_progress" });
		expect(result.state).toBe(created.state);
		expect(result.op.kind === "error" && result.op.message).toContain("illegal transition completed → in_progress");
	});
});

describe("initial status in batches", () => {
	test("creates an active task and pending follow-ups with refs and dependencies", () => {
		const ops: TaskOp[] = [
			{
				action: "create",
				ref: "investigate",
				subject: "Investigate",
				status: "in_progress",
				activeForm: "investigating",
			},
			{ action: "create", ref: "fix", subject: "Fix", status: "pending", blockedBy: ["investigate"] },
			{ action: "create", subject: "Verify", status: "pending", blockedBy: ["fix"] },
		];
		const result = applyTaskMutation(EMPTY_STATE, "batch", { ops });
		expect(result.op.kind).toBe("batch");
		expect(result.state.tasks).toEqual([
			{ id: 1, subject: "Investigate", status: "in_progress", activeForm: "investigating" },
			{ id: 2, subject: "Fix", status: "pending", blockedBy: [1] },
			{ id: 3, subject: "Verify", status: "pending", blockedBy: [2] },
		]);
		expect(result.state.nextId).toBe(4);
		const output = buildToolResult("batch", { ops }, result.state, result.op);
		expect(output.isError).not.toBe(true);
		expect(output.content[0]!.text).toContain("created #1: Investigate (in_progress)");
		expect(output.details.batchResults?.map((op) => op.toStatus)).toEqual(["in_progress", "pending", "pending"]);
	});

	test("completed descendants can be created beneath completed ancestors", () => {
		const result = applyTaskMutation(EMPTY_STATE, "batch", {
			ops: [
				{ action: "create", ref: "root", subject: "Root", status: "completed" },
				{ action: "create", ref: "child", subject: "Child", status: "completed", parentId: "root" },
				{ action: "create", subject: "Grandchild", status: "completed", parentId: "child" },
			],
		});
		expect(result.op.kind).toBe("batch");
		expect(result.state.tasks.map((task) => task.parentId)).toEqual([undefined, 1, 2]);
		expect(result.state.tasks.every((task) => task.status === "completed")).toBe(true);
	});

	for (const status of [undefined, "pending", "in_progress"] as const) {
		test(`unfinished child (${status ?? "default"}) under completed ancestor rolls back the batch`, () => {
			const ops: TaskOp[] = [
				{ action: "create", ref: "root", subject: "Root", status: "completed" },
				{ action: "create", ref: "child", subject: "Child", status: "completed", parentId: "root" },
				{ action: "create", subject: "Unfinished", status, parentId: "child" },
			];
			const result = applyTaskMutation(EMPTY_STATE, "batch", { ops });
			expect(result.state).toBe(EMPTY_STATE);
			expect(result.op.kind === "error" && result.op.message).toContain("batch op 3 (create)");
			expect(result.op.kind === "error" && result.op.message).toContain("completed ancestor");
			const output = buildToolResult("batch", { ops }, result.state, result.op);
			expect(output.isError).toBe(true);
			expect(output.details.batchResults).toBeUndefined();
		});
	}

	test("invalid status in a later op rolls back earlier creates", () => {
		const ops: TaskOp[] = [
			{ action: "create", subject: "Investigate", status: "in_progress" },
			{ action: "create", subject: "Invalid", status: "deleted" },
		];
		const result = applyTaskMutation(EMPTY_STATE, "batch", { ops });
		expect(result.state).toBe(EMPTY_STATE);
		expect(result.op.kind === "error" && result.op.message).toContain("batch op 2 (create)");
		expect(result.op.kind === "error" && result.op.message).toContain("no changes applied");
	});
});
