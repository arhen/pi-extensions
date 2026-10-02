import { describe, expect, test } from "bun:test";
import { applyTaskMutation, buildToolResult, deriveBlocks } from "../src/state.ts";
import { EMPTY_STATE, TodoParamsSchema, type Task, type TaskAction, type TaskMutationParams, type TaskState, type TaskStatus } from "../src/types.ts";

function task(id: number, status: TaskStatus = "pending", parentId?: number): Task {
	return { id, subject: `task ${id}`, status, ...(parentId === undefined ? {} : { parentId }) };
}

function snapshot(...tasks: Task[]): TaskState {
	return { tasks, nextId: Math.max(0, ...tasks.map((item) => item.id)) + 1 };
}

function find(state: TaskState, id: number): Task {
	return state.tasks.find((item) => item.id === id)!;
}

function mutate(state: TaskState, action: TaskAction, params: TaskMutationParams): TaskState {
	const result = applyTaskMutation(state, action, params);
	expect(result.op.kind).not.toBe("error");
	return result.state;
}

function reject(state: TaskState, action: TaskAction, params: TaskMutationParams, message?: string): void {
	const before = structuredClone(state);
	const result = applyTaskMutation(state, action, params);
	expect(result.op.kind).toBe("error");
	expect(result.state).toBe(state);
	expect(state).toEqual(before);
	if (message) expect(result.op.kind === "error" && result.op.message).toContain(message);
}

function chain(depth: number, status: TaskStatus): TaskState {
	const tasks = Array.from({ length: depth }, (_, index) => task(index + 1, status, index === 0 ? undefined : index));
	return { tasks, nextId: depth + 1 };
}

describe("hierarchy compatibility and API", () => {
	test("old flat snapshots retain their shape and behavior", () => {
		let state: TaskState = JSON.parse('{"tasks":[{"id":1,"subject":"old root","status":"pending"},{"id":2,"subject":"old dependent","status":"pending","blockedBy":[1]},{"id":3,"subject":"old tombstone","status":"deleted"}],"nextId":4}');
		const original = JSON.stringify(state);
		expect(applyTaskMutation(state, "list", {}).state).toBe(state);
		expect(applyTaskMutation(state, "get", { id: 2 }).op).toMatchObject({ kind: "get", task: state.tasks[1] });
		state = mutate(state, "create", { subject: "new root" });
		expect(find(state, 4)).toEqual({ id: 4, subject: "new root", status: "pending" });
		state = mutate(state, "update", { id: 1, status: "in_progress", activeForm: "working" });
		state = mutate(state, "update", { id: 1, status: "completed" });
		state = mutate(state, "delete", { id: 1 });
		expect(find(state, 1).status).toBe("deleted");
		expect(find(state, 2).blockedBy).toEqual([]);
		expect(state.tasks.every((item) => !Object.hasOwn(item, "parentId"))).toBe(true);
		expect(state.nextId).toBe(5);
		expect(original).not.toContain("parentId");
	});

	test("schema accepts numeric or null parentId", () => {
		expect(TodoParamsSchema.properties.parentId.anyOf.map((item) => item.type)).toEqual(["number", "null"]);
	});

	test("omitted and null create parents both produce roots", () => {
		let state = mutate(EMPTY_STATE, "create", { subject: "implicit root" });
		state = mutate(state, "create", { subject: "explicit root", parentId: null });
		expect(state.tasks.map((item) => item.parentId)).toEqual([undefined, undefined]);
		expect(state.tasks.every((item) => !Object.hasOwn(item, "parentId"))).toBe(true);
	});

	test("numeric parents persist through tool details and JSON snapshots", () => {
		const before = snapshot(task(1));
		const params = { subject: "child", parentId: 1 };
		const result = applyTaskMutation(before, "create", params);
		expect(result.op).toEqual({ kind: "create", taskId: 2 });
		expect(find(result.state, 2).parentId).toBe(1);
		expect(buildToolResult("create", params, result.state, result.op).details.tasks[1]?.parentId).toBe(1);
		expect(JSON.parse(JSON.stringify(result.state))).toEqual(result.state);
		expect(before).toEqual(snapshot(task(1)));
	});

	test("parent-only update counts as mutable, same parent is a no-op", () => {
		const state = snapshot(task(1), task(2));
		const moved = applyTaskMutation(state, "update", { id: 2, parentId: 1 });
		expect(moved.op).toMatchObject({ kind: "update", changed: true });
		expect(find(moved.state, 2).parentId).toBe(1);
		const same = applyTaskMutation(moved.state, "update", { id: 2, parentId: 1 });
		expect(same.op).toMatchObject({ kind: "update", changed: false });
		const rootNoOp = applyTaskMutation(state, "update", { id: 1, parentId: null });
		expect(rootNoOp.op).toMatchObject({ kind: "update", changed: false });
	});

	test("omitting parent preserves it during updates", () => {
		const state = snapshot(task(1), task(2, "pending", 1));
		const updated = mutate(state, "update", { id: 2, subject: "renamed", status: "in_progress", activeForm: "working" });
		expect(find(updated, 2)).toMatchObject({ parentId: 1, subject: "renamed", status: "in_progress" });
	});

	test("clear still resets tasks and ids", () => {
		const state = snapshot(task(1), task(2, "pending", 1));
		expect(mutate(state, "clear", {})).toEqual(EMPTY_STATE);
	});
});

describe("hierarchy moves", () => {
	test("moving a subtree preserves its descendants and other fields", () => {
		const state = snapshot(task(1), task(2), { ...task(3, "in_progress", 1), description: "detail", activeForm: "working", owner: "agent", metadata: { key: "value" }, blockedBy: [2] }, task(4, "pending", 3));
		const updated = mutate(state, "update", { id: 3, parentId: 2 });
		expect(find(updated, 3)).toEqual({ ...find(state, 3), parentId: 2 });
		expect(find(updated, 4)).toBe(find(state, 4));
		expect(find(state, 3).parentId).toBe(1);
	});

	test("null reparents a whole subtree to root without persisting null", () => {
		const state = snapshot(task(1), task(2, "pending", 1), task(3, "pending", 2));
		const result = applyTaskMutation(state, "update", { id: 2, parentId: null });
		expect(result.op).toMatchObject({ kind: "update", changed: true });
		expect(Object.hasOwn(find(result.state, 2), "parentId")).toBe(false);
		expect(find(result.state, 3).parentId).toBe(2);
		expect(find(state, 2).parentId).toBe(1);
	});

	test("successful reparent and deletion never mutate frozen input", () => {
		const state = snapshot(task(1), task(2), { ...task(3, "pending", 1), blockedBy: [1, 2] }, { ...task(4, "pending", 3), blockedBy: [2, 3] });
		for (const item of state.tasks) {
			if (item.blockedBy) Object.freeze(item.blockedBy);
			Object.freeze(item);
		}
		Object.freeze(state.tasks);
		Object.freeze(state);
		const moved = mutate(state, "update", { id: 3, parentId: 2 });
		const deleted = mutate(moved, "delete", { id: 3 });
		expect(find(state, 3).parentId).toBe(1);
		expect(find(state, 4)).toMatchObject({ parentId: 3, blockedBy: [2, 3] });
		expect(find(deleted, 4)).toMatchObject({ parentId: 2, blockedBy: [2] });
	});

	test("a completed subtree can move under completed ancestors", () => {
		const state = snapshot(task(1, "completed"), task(2, "completed", 1), task(3, "completed"), task(4, "completed", 3));
		const updated = mutate(state, "update", { id: 3, parentId: 2 });
		expect(find(updated, 3).parentId).toBe(2);
		expect(find(updated, 4).parentId).toBe(3);
	});

	test("completion and move are validated against the final root status", () => {
		const state = snapshot(task(1, "completed"), task(2), task(3, "completed", 2));
		const updated = mutate(state, "update", { id: 2, parentId: 1, status: "completed" });
		expect(find(updated, 2)).toMatchObject({ status: "completed", parentId: 1 });
	});
});

describe("hierarchy validation and atomic rejection", () => {
	for (const parentId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", false, {}, []]) {
		test(`invalid parent ${String(parentId)} is rejected on create and update`, () => {
			const state = snapshot(task(1), task(2));
			const params = { parentId } as TaskMutationParams;
			reject(state, "create", { subject: "child", ...params }, "parentId");
			reject(state, "update", { id: 2, ...params }, "parentId");
		});
	}

	test("missing and deleted direct parents are rejected", () => {
		const state = snapshot(task(1, "deleted"), task(2));
		for (const action of ["create", "update"] as const) {
			const params = action === "create" ? { subject: "new" } : { id: 2 };
			reject(state, action, { ...params, parentId: 99 }, "not found");
			reject(state, action, { ...params, parentId: 1 }, "deleted");
		}
	});

	test("self-parent is rejected for update and the next created id", () => {
		const state = snapshot(task(1), task(2));
		reject(state, "update", { id: 2, parentId: 2 }, "itself");
		reject(state, "create", { subject: "new", parentId: 3 }, "itself");
	});

	test("ancestor-to-descendant moves reject direct and indirect cycles", () => {
		const state = snapshot(task(1), task(2, "pending", 1), task(3, "pending", 2));
		reject(state, "update", { id: 1, parentId: 2 }, "cycle");
		reject(state, "update", { id: 1, parentId: 3 }, "cycle");
		reject(state, "update", { id: 2, parentId: 3 }, "cycle");
	});

	test("cycle validation traverses tombstoned ancestors", () => {
		const state = snapshot(task(1), task(2, "deleted", 1), task(3, "pending", 2));
		reject(state, "update", { id: 1, parentId: 3 }, "cycle");
	});

	test("unfinished tasks cannot be inserted under direct or indirect completed ancestors", () => {
		const state = snapshot(task(1, "completed"), task(2, "completed", 1), task(3));
		for (const parentId of [1, 2]) {
			reject(state, "create", { subject: "new", parentId }, "completed ancestor");
			reject(state, "update", { id: 3, parentId }, "completed ancestor");
		}
		const restored = snapshot(task(1, "completed"), task(2, "pending", 1), task(3));
		reject(restored, "create", { subject: "new", parentId: 2 }, "ancestor #1");
		reject(restored, "update", { id: 3, parentId: 2 }, "ancestor #1");
	});

	test("a completed restored subtree with an unfinished descendant cannot move under completed ancestors", () => {
		const state = snapshot(task(1, "completed"), task(2, "completed"), task(3, "deleted", 2), task(4, "pending", 3));
		reject(state, "update", { id: 2, parentId: 1 }, "unfinished subtree");
	});

	test("rejected hierarchy updates leave status, fields, metadata and dependencies untouched", () => {
		const state = snapshot(task(1), { ...task(2, "pending", 1), subject: "old", description: "old detail", metadata: { keep: 1 }, blockedBy: [1] }, task(3));
		reject(state, "update", { id: 2, parentId: 2, subject: "new", description: "new detail", status: "in_progress", metadata: { keep: null, add: 2 }, removeBlockedBy: [1], addBlockedBy: [3] }, "itself");
	});

	test("dependency rejection does not partially commit a valid reparent", () => {
		const state = snapshot(task(1), task(2), task(3, "pending", 1));
		reject(state, "update", { id: 3, parentId: 2, subject: "new", addBlockedBy: [99] }, "not found");
		reject(state, "create", { subject: "new", parentId: 1, blockedBy: [99] }, "not found");
	});

	test("deleted tasks stay immutable even for parent-only updates", () => {
		const state = snapshot(task(1), task(2, "deleted", 1));
		reject(state, "update", { id: 2, parentId: null }, "immutable");
	});
});

describe("explicit hierarchy statuses", () => {
	test("parents cannot complete with pending or in-progress descendants", () => {
		const state = snapshot(task(1, "in_progress"), task(2, "completed", 1), task(3, "pending", 2), task(4, "in_progress", 1));
		reject(state, "update", { id: 1, status: "completed", subject: "new", parentId: null }, "unfinished");
		reject(state, "update", { id: 2, status: "completed" }, "unfinished");
	});

	test("live descendants behind restored tombstones still block completion", () => {
		const state = snapshot(task(1), task(2, "deleted", 1), task(3, "pending", 2));
		reject(state, "update", { id: 1, status: "completed" }, "descendant #3");
	});

	test("deleted descendants do not block completion", () => {
		const state = snapshot(task(1), task(2, "deleted", 1), task(3, "completed", 1), task(4, "deleted", 3));
		expect(find(mutate(state, "update", { id: 1, status: "completed" }), 1).status).toBe("completed");
	});

	test("child completion never automatically changes any ancestor status", () => {
		let state = snapshot(task(1), task(2, "in_progress", 1), task(3, "pending", 2));
		state = mutate(state, "update", { id: 3, status: "completed" });
		expect(state.tasks.map((item) => item.status)).toEqual(["pending", "in_progress", "completed"]);
		state = mutate(state, "update", { id: 2, status: "completed" });
		expect(find(state, 1).status).toBe("pending");
		state = mutate(state, "update", { id: 1, status: "completed" });
		expect(state.tasks.every((item) => item.status === "completed")).toBe(true);
	});

	test("hierarchy does not impose dependency completion or change status transitions", () => {
		let state = snapshot(task(1), { ...task(2, "pending", 1), blockedBy: [1] });
		state = mutate(state, "update", { id: 2, status: "completed" });
		expect(find(state, 2).blockedBy).toEqual([1]);
		reject(state, "update", { id: 2, status: "pending" }, "illegal transition");
		reject(state, "update", { id: 2, status: "in_progress" }, "illegal transition");
	});
});

describe("child promotion and tombstones", () => {
	for (const action of ["delete", "update"] as const) {
		const params = (id: number): TaskMutationParams => action === "delete" ? { id } : { id, status: "deleted" };

		test(`${action} promotes live direct children, preserving statuses and grandchildren`, () => {
			const state = snapshot(task(1), { ...task(2, "in_progress", 1), owner: "owner", metadata: { keep: true } }, task(3, "pending", 2), task(4, "completed", 2), task(5, "deleted", 2), task(6, "pending", 3));
			const updated = mutate(state, action, params(2));
			expect(find(updated, 2)).toMatchObject({ status: "deleted", parentId: 1, owner: "owner", metadata: { keep: true } });
			expect(find(updated, 3)).toEqual({ ...find(state, 3), parentId: 1 });
			expect(find(updated, 4)).toEqual({ ...find(state, 4), parentId: 1 });
			expect(find(updated, 5)).toBe(find(state, 5));
			expect(find(updated, 6)).toBe(find(state, 6));
			expect(updated.tasks).toHaveLength(state.tasks.length);
			expect(updated.nextId).toBe(state.nextId);
			expect(find(state, 2).status).toBe("in_progress");
			expect(find(state, 3).parentId).toBe(2);
		});

		test(`${action} of a root promotes live children to roots`, () => {
			const state = snapshot(task(1), task(2, "pending", 1), task(3, "pending", 2));
			const updated = mutate(state, action, params(1));
			expect(find(updated, 1).status).toBe("deleted");
			expect(Object.hasOwn(find(updated, 2), "parentId")).toBe(false);
			expect(find(updated, 3).parentId).toBe(2);
		});

		test(`${action} skips restored deleted ancestors to find the nearest live parent`, () => {
			const state = snapshot(task(1), task(2, "deleted", 1), task(3, "deleted", 2), task(4, "pending", 3), task(5, "pending", 4));
			const updated = mutate(state, action, params(4));
			expect(find(updated, 5).parentId).toBe(1);
			expect(find(updated, 4).parentId).toBe(3);
			expect(find(updated, 2)).toBe(find(state, 2));
		});

		test(`${action} promotes to root when the entire ancestor chain is deleted`, () => {
			const state = snapshot(task(1, "deleted"), task(2, "deleted", 1), task(3, "pending", 2), task(4, "pending", 3));
			expect(find(mutate(state, action, params(3)), 4).parentId).toBeUndefined();
		});

		test(`${action} preserves unrelated dependency edges and removes only deleted-id edges`, () => {
			const state = snapshot(task(1), { ...task(2, "pending", 1), blockedBy: [1] }, { ...task(3, "pending", 2), blockedBy: [1, 2, 4] }, task(4), { ...task(5), blockedBy: [2, 4] });
			const updated = mutate(state, action, params(2));
			expect(find(updated, 3).parentId).toBe(1);
			expect(find(updated, 2).blockedBy).toEqual([1]);
			expect(find(updated, 3).blockedBy).toEqual([1, 4]);
			expect(find(updated, 5).blockedBy).toEqual([4]);
			expect(deriveBlocks(updated.tasks).get(4)).toEqual([3, 5]);
		});
	}

	test("update can reparent and delete atomically, promoting children to the new parent", () => {
		const state = snapshot(task(1), task(2), task(3, "pending", 1), task(4, "pending", 3));
		const updated = mutate(state, "update", { id: 3, parentId: 2, status: "deleted" });
		expect(find(updated, 3)).toMatchObject({ parentId: 2, status: "deleted" });
		expect(find(updated, 4).parentId).toBe(2);
		const rooted = mutate(state, "update", { id: 3, parentId: null, status: "deleted" });
		expect(find(rooted, 4).parentId).toBeUndefined();
	});
});

describe("restored malformed hierarchy", () => {
	test("attaching to a cyclic ancestry is rejected, but null can repair the cycle", () => {
		const state = snapshot(task(1, "completed", 2), task(2, "completed", 1), task(3, "completed"));
		reject(state, "update", { id: 3, parentId: 1 }, "cycle");
		const repaired = mutate(state, "update", { id: 1, parentId: null });
		expect(find(repaired, 1).parentId).toBeUndefined();
		expect(find(repaired, 2).parentId).toBe(1);
	});

	test("create into a restored cycle terminates and rejects", () => {
		const state = snapshot(task(1, "pending", 2), task(2, "pending", 1));
		reject(state, "create", { subject: "new", parentId: 1 }, "cycle");
	});

	test("missing or malformed ancestry rejects attachment without affecting unrelated roots", () => {
		for (const parentId of [99, "bad", Number.NaN, {}]) {
			const state = snapshot({ ...task(1), parentId } as Task, task(2));
			reject(state, "create", { subject: "new", parentId: 1 }, "parentId");
			reject(state, "update", { id: 2, parentId: 1 }, "parentId");
			expect(find(mutate(state, "update", { id: 1, parentId: null }), 1).parentId).toBeUndefined();
			expect(find(mutate(state, "create", { subject: "unrelated" }), 3).parentId).toBeUndefined();
		}
	});

	test("completion traverses cycles safely and never counts the task as its own descendant", () => {
		const state = snapshot(task(1, "pending", 2), task(2, "completed", 1));
		expect(find(mutate(state, "update", { id: 1, status: "completed" }), 1).status).toBe("completed");
		const unfinished = snapshot(task(1, "pending", 2), task(2, "in_progress", 1));
		reject(unfinished, "update", { id: 1, status: "completed" }, "unfinished");
	});

	for (const action of ["delete", "update"] as const) {
		test(`${action} breaks promotion cycles by placing surviving children at root`, () => {
			const state = snapshot(task(1, "pending", 2), task(2, "pending", 1), task(3, "pending", 1));
			const updated = mutate(state, action, { id: 1, ...(action === "update" ? { status: "deleted" as const } : {}) });
			expect(find(updated, 1).status).toBe("deleted");
			expect(find(updated, 2).parentId).toBeUndefined();
			expect(find(updated, 3).parentId).toBeUndefined();
		});

		test(`${action} uses root when deleted ancestor paths are malformed or missing`, () => {
			for (const parentId of [99, "bad", null]) {
				const state = snapshot({ ...task(1, "deleted"), parentId } as Task, task(2, "pending", 1), task(3, "pending", 2));
				const updated = mutate(state, action, { id: 2, ...(action === "update" ? { status: "deleted" as const } : {}) });
				expect(find(updated, 3).parentId).toBeUndefined();
			}
		});
	}
});

describe("deep iterative hierarchy", () => {
	const depth = 2500;

	test("the API can build a hierarchy beyond 2000 levels", () => {
		let state = EMPTY_STATE;
		for (let id = 1; id <= depth; id++) {
			state = mutate(state, "create", { subject: `task ${id}`, ...(id === 1 ? {} : { parentId: id - 1 }) });
		}
		expect(state.tasks).toHaveLength(depth);
		expect(find(state, depth).parentId).toBe(depth - 1);
		expect(state.nextId).toBe(depth + 1);
	});

	test("create, reparent, detach and cycle rejection work beyond 2000 levels", () => {
		let state = chain(depth, "pending");
		state = mutate(state, "create", { subject: "deep child", parentId: depth });
		expect(find(state, depth + 1).parentId).toBe(depth);
		reject(state, "update", { id: 1, parentId: depth + 1 }, "cycle");
		state = mutate(state, "create", { subject: "other root" });
		state = mutate(state, "update", { id: 1, parentId: depth + 2 });
		expect(find(state, 1).parentId).toBe(depth + 2);
		state = mutate(state, "update", { id: 1, parentId: null });
		expect(find(state, 1).parentId).toBeUndefined();
		expect(find(state, depth + 1).parentId).toBe(depth);
	});

	test("completion visits a fully finished deep subtree without recursion", () => {
		const state = chain(depth, "completed");
		state.tasks[0] = task(1, "in_progress");
		expect(find(mutate(state, "update", { id: 1, status: "completed" }), 1).status).toBe("completed");
		state.tasks[depth - 1] = task(depth, "pending", depth - 1);
		reject(state, "update", { id: 1, status: "completed" }, `descendant #${depth}`);
	});

	test("unfinished deep restored descendants cannot move under completed ancestors", () => {
		const state = chain(depth, "completed");
		state.tasks[depth - 1] = task(depth, "pending", depth - 1);
		state.tasks.push(task(depth + 1, "completed"));
		state.nextId++;
		reject(state, "update", { id: 1, parentId: depth + 1 }, "unfinished subtree");
	});

	test("completed ancestry validation and cycle detection walk the entire deep chain", () => {
		const state = chain(depth, "completed");
		state.tasks.push(task(depth + 1, "completed"));
		state.nextId++;
		expect(find(mutate(state, "update", { id: depth + 1, parentId: depth }), depth + 1).parentId).toBe(depth);
		reject(state, "update", { id: 1, parentId: depth }, "cycle");
	});

	for (const action of ["delete", "update"] as const) {
		test(`${action} promotion skips more than 2000 tombstoned ancestors`, () => {
			const state = chain(depth, "deleted");
			state.tasks[0] = task(1);
			state.tasks[depth - 1] = task(depth, "pending", depth - 1);
			state.tasks.push(task(depth + 1, "pending", depth));
			state.nextId++;
			const updated = mutate(state, action, { id: depth, ...(action === "update" ? { status: "deleted" as const } : {}) });
			expect(find(updated, depth + 1).parentId).toBe(1);
			expect(find(updated, depth).parentId).toBe(depth - 1);
		});
	}

	test("a deep restored ancestry cycle terminates on validation and deletion", () => {
		const state = chain(depth, "pending");
		state.tasks[0] = task(1, "pending", depth);
		reject(state, "create", { subject: "new", parentId: depth }, "cycle");
		const updated = mutate(state, "delete", { id: depth });
		expect(find(updated, 1).parentId).toBeUndefined();
		expect(find(updated, depth).status).toBe("deleted");
	});
});
