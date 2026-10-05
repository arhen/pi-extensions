/**
 * Batch action: ordered create/update/delete ops, ref aliases, atomic abort.
 * Pure logic only — no pi runtime needed. Run: bun test
 */
import { describe, expect, test } from "bun:test";
import { applyTaskMutation } from "../src/state.ts";
import { EMPTY_STATE, type TaskOp } from "../src/types.ts";

function seed(): ReturnType<typeof applyTaskMutation>["state"] {
	let state = EMPTY_STATE;
	state = applyTaskMutation(state, "create", { subject: "first" }).state;
	state = applyTaskMutation(state, "create", { subject: "second" }).state;
	return state;
}

function batch(state = EMPTY_STATE, ops: TaskOp[]) {
	return applyTaskMutation(state, "batch", { ops });
}

describe("batch create", () => {
	test("creates several tasks in one call", () => {
		const result = batch(EMPTY_STATE, [
			{ action: "create", subject: "one" },
			{ action: "create", subject: "two" },
		]);
		expect(result.op.kind).toBe("batch");
		expect(result.state.tasks.map((task) => task.subject)).toEqual(["one", "two"]);
		expect(result.state.tasks.map((task) => task.id)).toEqual([1, 2]);
		expect(result.state.nextId).toBe(3);
	});
	test("refs wire hierarchy, dependencies, and updates in one batch", () => {
		const result = batch(EMPTY_STATE, [
			{ action: "create", ref: "parent", subject: "parent" },
			{ action: "create", ref: "child", subject: "child", parentId: "parent" },
			{ action: "create", subject: "blocked", blockedBy: ["child"] },
			{ action: "update", id: "child", status: "in_progress", activeForm: "working" },
		]);
		expect(result.op.kind).toBe("batch");
		const [parent, child, blocked] = result.state.tasks;
		expect(parent).toMatchObject({ id: 1, subject: "parent" });
		expect(parent!.parentId).toBeUndefined();
		expect(child).toMatchObject({ id: 2, parentId: 1, status: "in_progress", activeForm: "working" });
		expect(blocked).toMatchObject({ id: 3, blockedBy: [2] });
	});
	test("numeric string ids resolve as ids, not refs", () => {
		const state = seed();
		const result = batch(state, [{ action: "update", id: "1", status: "completed" }]);
		expect(result.op.kind).toBe("batch");
		expect(result.state.tasks[0]!.status).toBe("completed");
	});
	test("results carry resolved ids and labels", () => {
		const result = batch(EMPTY_STATE, [
			{ action: "create", subject: "parent" },
			{ action: "create", subject: "child", parentId: 1 },
			{ action: "update", id: 2, status: "in_progress" },
		]);
		expect(result.op.kind === "batch" && result.op.results).toEqual([
			{ action: "create", id: 1, subject: "parent", toStatus: "pending" },
			{ action: "create", id: 2, subject: "child", toStatus: "pending" },
			{ action: "update", id: 2, subject: "child", fromStatus: "pending", toStatus: "in_progress", changed: true },
		]);
	});
});

describe("batch update/delete", () => {
	test("updates and deletes targets from one call", () => {
		const result = batch(seed(), [
			{ action: "update", id: 1, status: "completed" },
			{ action: "delete", id: 2 },
		]);
		expect(result.op.kind).toBe("batch");
		expect(result.state.tasks.map((task) => task.status)).toEqual(["completed", "deleted"]);
	});
	test("deleting a parent in a batch promotes its live children", () => {
		const result = batch(EMPTY_STATE, [
			{ action: "create", ref: "p", subject: "parent" },
			{ action: "create", subject: "child", parentId: "p" },
			{ action: "delete", id: "p" },
		]);
		expect(result.op.kind).toBe("batch");
		expect(result.state.tasks[1]!.parentId).toBeUndefined();
	});
	test("no-op update inside a batch reports unchanged but still succeeds", () => {
		const result = batch(seed(), [{ action: "update", id: 1, status: "pending" }]);
		expect(result.op.kind).toBe("batch");
		expect(result.op.kind === "batch" && result.op.results[0]).toMatchObject({ changed: false, toStatus: "pending" });
	});
});

describe("batch atomicity", () => {
	test("a failed op aborts the whole batch", () => {
		const before = seed();
		const result = batch(before, [
			{ action: "create", subject: "never persisted" },
			{ action: "update", id: 99, status: "completed" },
		]);
		expect(result.op.kind).toBe("error");
		expect(result.op.kind === "error" && result.op.message).toContain("batch op 2 (update)");
		expect(result.op.kind === "error" && result.op.message).toContain("no changes applied");
		expect(result.state).toEqual(before);
	});
	test("invalid later op does not leak earlier creates", () => {
		const result = batch(EMPTY_STATE, [
			{ action: "create", subject: "one" },
			{ action: "update", id: 1 },
		]);
		expect(result.op.kind).toBe("error");
		expect(result.state.tasks).toEqual([]);
		expect(result.state.nextId).toBe(1);
	});
});

describe("batch validation", () => {
	test("rejects empty ops", () => {
		expect(batch(EMPTY_STATE, []).op.kind).toBe("error");
	});
	test("rejects stray top-level fields", () => {
		const result = applyTaskMutation(EMPTY_STATE, "batch", { ops: [{ action: "create", subject: "x" }], subject: "sneaky" });
		expect(result.op.kind).toBe("error");
		expect(result.op.kind === "error" && result.op.message).toContain("batch accepts only: ops");
	});
	test("rejects ops outside batch", () => {
		expect(applyTaskMutation(EMPTY_STATE, "create", { subject: "x", ops: [{ action: "create", subject: "y" }] }).op.kind).toBe("error");
	});
	test("rejects non-mutation op actions", () => {
		const result = applyTaskMutation(EMPTY_STATE, "batch", { ops: [{ action: "list" } as unknown as TaskOp] });
		expect(result.op.kind === "error" && result.op.message).toContain("action must be create, update, or delete");
	});
	test("rejects unknown, duplicate, and forward refs", () => {
		expect(batch(EMPTY_STATE, [{ action: "update", id: "nope", status: "completed" }]).op.kind).toBe("error");
		const duplicate = batch(EMPTY_STATE, [
			{ action: "create", ref: "once", subject: "a" },
			{ action: "create", ref: "once", subject: "b" },
		]);
		expect(duplicate.op.kind === "error" && duplicate.op.message).toContain("duplicate ref");
		const forward = batch(EMPTY_STATE, [{ action: "create", ref: "self", subject: "a", parentId: "self" }]);
		expect(forward.op.kind === "error" && forward.op.message).toContain("unknown ref");
	});
	test("rejects ref on non-create ops and invalid ref names", () => {
		expect(batch(seed(), [{ action: "update", id: 1, ref: "x", status: "pending" }]).op.kind).toBe("error");
		expect(batch(EMPTY_STATE, [{ action: "create", ref: "1bad", subject: "a" }]).op.kind).toBe("error");
	});
	test("rejects refs on deleted dependencies", () => {
		const result = batch(EMPTY_STATE, [
			{ action: "create", ref: "gone", subject: "gone" },
			{ action: "delete", id: "gone" },
			{ action: "create", subject: "late", blockedBy: ["gone"] },
		]);
		expect(result.op.kind).toBe("error");
	});
});
