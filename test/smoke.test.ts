/**
 * Smoke tests: reducer (transitions, blockedBy, cycles, no-op), sanitize, graph.
 * Pure logic only — no pi runtime needed. Run: bun test
 */
import { describe, expect, test } from "bun:test";
import { applyTaskMutation, detectCycle, isTransitionValid, sanitizeTerminalText } from "../src/state.ts";
import { EMPTY_STATE } from "../src/types.ts";

describe("transitions", () => {
	test("legal transitions", () => {
		expect(isTransitionValid("pending", "in_progress")).toBe(true);
		expect(isTransitionValid("pending", "completed")).toBe(true);
		expect(isTransitionValid("in_progress", "completed")).toBe(true);
		expect(isTransitionValid("in_progress", "pending")).toBe(true);
		expect(isTransitionValid("completed", "deleted")).toBe(true);
	});
	test("illegal transitions", () => {
		expect(isTransitionValid("completed", "in_progress")).toBe(false);
		expect(isTransitionValid("deleted", "pending")).toBe(false);
		expect(isTransitionValid("deleted", "completed")).toBe(false);
	});
});

describe("create/update", () => {
	test("create assigns sequential ids", () => {
		let s = EMPTY_STATE;
		s = applyTaskMutation(s, "create", { subject: "one" }).state;
		s = applyTaskMutation(s, "create", { subject: "two" }).state;
		expect(s.tasks.map((t) => t.id)).toEqual([1, 2]);
		expect(s.nextId).toBe(3);
	});
	test("create requires subject", () => {
		const r = applyTaskMutation(EMPTY_STATE, "create", {});
		expect(r.op.kind).toBe("error");
	});
	test("update with no mutable field rejected", () => {
		const s = applyTaskMutation(EMPTY_STATE, "create", { subject: "x" }).state;
		const r = applyTaskMutation(s, "update", { id: 1 });
		expect(r.op.kind).toBe("error");
	});
	test("no-op update reports unchanged", () => {
		const s = applyTaskMutation(EMPTY_STATE, "create", { subject: "x" }).state;
		const r = applyTaskMutation(s, "update", { id: 1, status: "pending" });
		expect(r.op).toMatchObject({ kind: "update", changed: false });
	});
	test("illegal status transition rejected", () => {
		const s = applyTaskMutation(EMPTY_STATE, "create", { subject: "x" }).state;
		const completed = applyTaskMutation(s, "update", { id: 1, status: "completed" }).state;
		const r = applyTaskMutation(completed, "update", { id: 1, status: "in_progress" });
		expect(r.op.kind).toBe("error");
	});
});

describe("blockedBy", () => {
	test("create with missing dep rejected", () => {
		const r = applyTaskMutation(EMPTY_STATE, "create", { subject: "x", blockedBy: [99] });
		expect(r.op.kind).toBe("error");
	});
	test("self-block rejected", () => {
		const s = applyTaskMutation(EMPTY_STATE, "create", { subject: "x" }).state;
		const r = applyTaskMutation(s, "update", { id: 1, addBlockedBy: [1] });
		expect(r.op.kind).toBe("error");
	});
	test("cycle rejected", () => {
		let s = applyTaskMutation(EMPTY_STATE, "create", { subject: "a" }).state;
		s = applyTaskMutation(s, "create", { subject: "b" }).state;
		s = applyTaskMutation(s, "update", { id: 1, addBlockedBy: [2] }).state; // 1 blocked by 2
		const r = applyTaskMutation(s, "update", { id: 2, addBlockedBy: [1] }); // 2 blocked by 1 → cycle
		expect(r.op.kind).toBe("error");
		expect(r.op.kind === "error" && r.op.message).toContain("cycle");
	});
	test("add/remove deps", () => {
		let s = applyTaskMutation(EMPTY_STATE, "create", { subject: "a" }).state;
		s = applyTaskMutation(s, "create", { subject: "b" }).state;
		s = applyTaskMutation(s, "update", { id: 2, addBlockedBy: [1] }).state;
		expect(s.tasks[1]!.blockedBy).toEqual([1]);
		s = applyTaskMutation(s, "update", { id: 2, removeBlockedBy: [1] }).state;
		expect(s.tasks[1]!.blockedBy).toBeUndefined();
	});
	test("blockedBy on deleted dep rejected", () => {
		let s = applyTaskMutation(EMPTY_STATE, "create", { subject: "a" }).state;
		s = applyTaskMutation(s, "create", { subject: "b" }).state;
		s = applyTaskMutation(s, "delete", { id: 1 }).state;
		const r = applyTaskMutation(s, "create", { subject: "c", blockedBy: [1] });
		expect(r.op.kind).toBe("error");
	});
});

describe("delete/clear/list/get", () => {
	test("delete tombstones", () => {
		const s = applyTaskMutation(EMPTY_STATE, "create", { subject: "x" }).state;
		const r = applyTaskMutation(s, "delete", { id: 1 });
		expect(r.op.kind).toBe("delete");
		expect(r.state.tasks[0]!.status).toBe("deleted");
	});
	test("clear resets", () => {
		let s = applyTaskMutation(EMPTY_STATE, "create", { subject: "x" }).state;
		s = applyTaskMutation(s, "clear", {}).state;
		expect(s.tasks).toEqual([]);
		expect(s.nextId).toBe(1);
	});
	test("list filters + includeDeleted", () => {
		let s = applyTaskMutation(EMPTY_STATE, "create", { subject: "x" }).state;
		s = applyTaskMutation(s, "delete", { id: 1 }).state;
		const r = applyTaskMutation(s, "list", {});
		expect(r.op.kind === "list" && r.op.includeDeleted).toBe(false);
		const r2 = applyTaskMutation(s, "list", { includeDeleted: true });
		expect(r2.op.kind === "list" && r2.op.includeDeleted).toBe(true);
	});
	test("get unknown id errors", () => {
		const r = applyTaskMutation(EMPTY_STATE, "get", { id: 42 });
		expect(r.op.kind).toBe("error");
	});
});

describe("graph + sanitize", () => {
	test("detectCycle flags direct cycle", () => {
		const tasks = [
			{ id: 1, subject: "a", status: "pending" as const, blockedBy: [2] },
			{ id: 2, subject: "b", status: "pending" as const },
		];
		expect(detectCycle(tasks, 2, [1])).toBe(true);
		expect(detectCycle(tasks, 1, [])).toBe(false);
	});
	test("sanitize strips CSI + newlines", () => {
		expect(sanitizeTerminalText("a\u001b[31mb\nc")).toBe("ab c");
		expect(sanitizeTerminalText("plain")).toBe("plain");
	});
});
