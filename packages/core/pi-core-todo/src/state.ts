/**
 * Pure logic: transitions, dependency graph, reducer, formatting, sanitize.
 * No pi imports — fully unit-testable.
 */

import { TaskTree } from "./tree.ts";
import type {
	BatchOpResult,
	Task,
	TaskAction,
	TaskDetails,
	TaskMutationParams,
	TaskOp,
	TaskState,
	TaskStatus,
} from "./types.ts";

// ── transitions ──────────────────────────────────────────────────────────

export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
	pending: new Set(["in_progress", "completed", "deleted"]),
	in_progress: new Set(["pending", "completed", "deleted"]),
	completed: new Set(["deleted"]),
	deleted: new Set(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}

// ── dependency graph ─────────────────────────────────────────────────────

export function detectCycle(taskList: readonly Task[], taskId: number, newBlockedBy: readonly number[]): boolean {
	const edges = new Map<number, number[]>();
	for (const t of taskList) {
		if (t.id === taskId) {
			const merged = new Set([...(t.blockedBy ?? []), ...newBlockedBy]);
			edges.set(t.id, [...merged]);
		} else {
			edges.set(t.id, t.blockedBy ? [...t.blockedBy] : []);
		}
	}
	const visiting = new Set<number>();
	const visited = new Set<number>();
	const hasCycleFrom = (node: number): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;
		visiting.add(node);
		for (const nb of edges.get(node) ?? []) {
			if (hasCycleFrom(nb)) return true;
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};
	for (const node of edges.keys()) {
		if (hasCycleFrom(node)) return true;
	}
	return false;
}

export function deriveBlocks(taskList: readonly Task[]): Map<number, number[]> {
	const blocks = new Map<number, number[]>();
	for (const t of taskList) {
		for (const dep of t.blockedBy ?? []) {
			const arr = blocks.get(dep) ?? [];
			arr.push(t.id);
			blocks.set(dep, arr);
		}
	}
	return blocks;
}

// ── hierarchy ────────────────────────────────────────────────────────────

function isTaskId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function unfinishedDescendant(taskList: readonly Task[], taskId: number): Task | undefined {
	const children = new Map<number, Task[]>();
	for (const task of taskList) {
		if (!isTaskId(task.parentId)) continue;
		const siblings = children.get(task.parentId) ?? [];
		siblings.push(task);
		children.set(task.parentId, siblings);
	}
	const visited = new Set([taskId]);
	const stack = [...(children.get(taskId) ?? [])];
	while (stack.length) {
		const task = stack.pop()!;
		if (visited.has(task.id)) continue;
		visited.add(task.id);
		if (task.status !== "completed" && task.status !== "deleted") return task;
		for (const child of children.get(task.id) ?? []) stack.push(child);
	}
	return undefined;
}

function validateParent(
	taskList: readonly Task[],
	taskId: number,
	parentId: number | null,
	unfinished: boolean,
): string | undefined {
	if (parentId === null) return undefined;
	if (!isTaskId(parentId)) return "parentId must be a positive safe integer or null";
	if (parentId === taskId) return `cannot parent #${taskId} to itself`;
	const byId = new Map(taskList.map((task) => [task.id, task]));
	const parent = byId.get(parentId);
	if (!parent) return `parentId: #${parentId} not found`;
	if (parent.status === "deleted") return `parentId: #${parentId} is deleted`;
	const visited = new Set([taskId]);
	let ancestor: Task | undefined = parent;
	while (ancestor) {
		if (visited.has(ancestor.id)) return "parentId would create a cycle in the task hierarchy";
		visited.add(ancestor.id);
		if (unfinished && ancestor.status === "completed") {
			return `cannot place an unfinished subtree under completed ancestor #${ancestor.id}`;
		}
		if (ancestor.parentId == null) break;
		if (!isTaskId(ancestor.parentId)) return `parentId: invalid ancestry at #${ancestor.id}`;
		const ancestorId = ancestor.parentId;
		ancestor = byId.get(ancestorId);
		if (!ancestor) return `parentId: ancestor #${ancestorId} not found`;
	}
	return undefined;
}

function nearestLiveParent(taskList: readonly Task[], task: Task): number | undefined {
	const byId = new Map(taskList.map((item) => [item.id, item]));
	const visited = new Set([task.id]);
	let parentId = task.parentId;
	let nearest: number | undefined;
	while (isTaskId(parentId)) {
		if (visited.has(parentId)) return undefined;
		visited.add(parentId);
		const parent = byId.get(parentId);
		if (!parent) break;
		if (nearest === undefined && parent.status !== "deleted") nearest = parent.id;
		parentId = parent.parentId;
	}
	return nearest;
}

function removeDeletedRelations(taskList: readonly Task[], deleted: Task): Task[] {
	const parentId = nearestLiveParent(taskList, deleted);
	return taskList.map((task) => {
		let updated = task;
		if (task.status !== "deleted" && task.parentId === deleted.id) {
			updated = { ...task };
			if (parentId === undefined) delete updated.parentId;
			else updated.parentId = parentId;
		}
		if (updated.blockedBy?.includes(deleted.id)) {
			updated = { ...updated, blockedBy: updated.blockedBy.filter((id) => id !== deleted.id) };
		}
		return updated;
	});
}

// ── reducer ──────────────────────────────────────────────────────────────

export type Op =
	| { kind: "create"; taskId: number }
	| { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus; changed: boolean }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "batch"; results: BatchOpResult[] }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function sameNumberList(a: number[] | undefined, b: number[] | undefined): boolean {
	const x = a ?? [];
	const y = b ?? [];
	return x.length === y.length && x.every((v, i) => v === y[i]);
}

function taskChanged(before: Task, after: Task): boolean {
	return (
		before.subject !== after.subject ||
		before.status !== after.status ||
		before.parentId !== after.parentId ||
		before.description !== after.description ||
		before.activeForm !== after.activeForm ||
		before.owner !== after.owner ||
		!sameNumberList(before.blockedBy, after.blockedBy) ||
		JSON.stringify(before.metadata ?? null) !== JSON.stringify(after.metadata ?? null)
	);
}

// ── batch ────────────────────────────────────────────────────────────────

const REF_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/** Top-level fields rejected alongside action:batch — batch carries everything inside ops. */
const BATCH_STRAY_FIELDS = [
	"subject",
	"description",
	"activeForm",
	"status",
	"parentId",
	"blockedBy",
	"addBlockedBy",
	"removeBlockedBy",
	"owner",
	"metadata",
	"id",
	"includeDeleted",
] as const;

const BATCH_REF_LIST_FIELDS = ["blockedBy", "addBlockedBy", "removeBlockedBy"] as const;

interface BatchStep {
	state: TaskState;
	result: BatchOpResult;
}

/** Resolve a numeric id, a numeric string, or a ref created earlier in the same batch. */
function resolveBatchRef(value: unknown, refs: ReadonlyMap<string, number>): { id: number } | { error: string } {
	if (typeof value === "number") return isTaskId(value) ? { id: value } : { error: `invalid task id ${value}` };
	if (typeof value !== "string" || !value.trim()) return { error: "expected a task id or a batch ref" };
	const ref = value.trim();
	if (/^\d+$/.test(ref)) {
		const id = Number(ref);
		return isTaskId(id) ? { id } : { error: `invalid task id ${ref}` };
	}
	const id = refs.get(ref);
	return id === undefined
		? { error: `unknown ref "${ref}" (use a numeric id or a ref defined by an earlier create op)` }
		: { id };
}

/** Apply one batch op to the accumulated state; register its ref on success. */
function applyBatchOp(state: TaskState, op: TaskOp, refs: Map<string, number>): BatchStep | { error: string } {
	if (!op || typeof op !== "object") return { error: "each op must be an object" };
	const action = op.action;
	if (action !== "create" && action !== "update" && action !== "delete") {
		return {
			error: `action must be create, update, or delete (got ${action === undefined ? "nothing" : JSON.stringify(action)})`,
		};
	}
	if (op.ref !== undefined) {
		if (action !== "create") return { error: "ref is only valid on create ops" };
		if (typeof op.ref !== "string" || !REF_PATTERN.test(op.ref)) {
			return { error: "ref must start with a letter and use only letters, digits, '.', '_', or '-' (max 64 chars)" };
		}
		if (refs.has(op.ref)) return { error: `duplicate ref "${op.ref}"` };
	}
	const params: TaskMutationParams = {};
	if (op.subject !== undefined) params.subject = op.subject;
	if (op.description !== undefined) params.description = op.description;
	if (op.activeForm !== undefined) params.activeForm = op.activeForm;
	if (op.status !== undefined) params.status = op.status;
	if (op.owner !== undefined) params.owner = op.owner;
	if (op.metadata !== undefined) params.metadata = op.metadata;
	if (op.id !== undefined) {
		const resolved = resolveBatchRef(op.id, refs);
		if ("error" in resolved) return resolved;
		params.id = resolved.id;
	}
	if (op.parentId !== undefined) {
		if (op.parentId === null) params.parentId = null;
		else {
			const resolved = resolveBatchRef(op.parentId, refs);
			if ("error" in resolved) return resolved;
			params.parentId = resolved.id;
		}
	}
	for (const key of BATCH_REF_LIST_FIELDS) {
		const value = op[key];
		if (value === undefined) continue;
		if (!Array.isArray(value)) return { error: `${key} must be an array of task ids or refs` };
		const resolvedIds: number[] = [];
		for (const item of value) {
			const resolved = resolveBatchRef(item, refs);
			if ("error" in resolved) return resolved;
			resolvedIds.push(resolved.id);
		}
		params[key] = resolvedIds;
	}
	const outcome = applyTaskMutation(state, action, params);
	if (outcome.op.kind === "error") return { error: outcome.op.message };
	if (outcome.op.kind !== "create" && outcome.op.kind !== "update" && outcome.op.kind !== "delete") {
		return { error: "internal error: unsupported op result" };
	}
	const taskId = outcome.op.kind === "create" ? outcome.op.taskId : outcome.op.id;
	const task = outcome.state.tasks.find((t) => t.id === taskId)!;
	if (action === "create" && op.ref !== undefined) refs.set(op.ref, taskId);
	if (outcome.op.kind === "update") {
		return {
			state: outcome.state,
			result: {
				action: "update",
				id: taskId,
				subject: task.subject,
				fromStatus: outcome.op.fromStatus,
				toStatus: outcome.op.toStatus,
				changed: outcome.op.changed,
			},
		};
	}
	if (outcome.op.kind === "delete")
		return { state: outcome.state, result: { action: "delete", id: taskId, subject: task.subject } };
	return {
		state: outcome.state,
		result: { action: "create", id: taskId, subject: task.subject, toStatus: task.status },
	};
}

export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams): ApplyResult {
	if (action !== "batch" && params.ops !== undefined) return errorResult(state, "ops is only valid with action:batch");
	switch (action) {
		case "batch": {
			const ops = params.ops;
			if (!Array.isArray(ops) || ops.length === 0) return errorResult(state, "batch requires a non-empty ops array");
			const stray = BATCH_STRAY_FIELDS.filter((key) => params[key] !== undefined);
			if (stray.length) return errorResult(state, `batch accepts only: ops (remove: ${stray.join(", ")})`);
			const refs = new Map<string, number>();
			const results: BatchOpResult[] = [];
			let working = state;
			for (let i = 0; i < ops.length; i++) {
				const step = applyBatchOp(working, ops[i]!, refs);
				if ("error" in step) {
					return errorResult(state, `batch op ${i + 1} (${ops[i]?.action ?? "?"}): ${step.error}; no changes applied`);
				}
				working = step.state;
				results.push(step.result);
			}
			return { state: working, op: { kind: "batch", results } };
		}

		case "create": {
			const stray = ["addBlockedBy", "removeBlockedBy", "includeDeleted", "id"].filter(
				(key) => params[key] !== undefined,
			);
			if (stray.length) {
				return errorResult(
					state,
					`create accepts only: subject, description, activeForm, status, parentId, blockedBy, owner, metadata (remove: ${stray.join(", ")})`,
				);
			}
			const status = params.status === undefined ? "pending" : params.status;
			if (status !== "pending" && status !== "in_progress" && status !== "completed") {
				return errorResult(
					state,
					"create status must be pending, in_progress, or completed; use delete to tombstone an existing task",
				);
			}
			if (!params.subject?.trim()) return errorResult(state, "subject required for create");
			if (params.parentId !== undefined) {
				const error = validateParent(state.tasks, state.nextId, params.parentId, status !== "completed");
				if (error) return errorResult(state, error);
			}
			if (params.blockedBy?.length) {
				for (const dep of params.blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
				}
			}
			const newTask: Task = { id: state.nextId, subject: params.subject, status };
			if (params.parentId != null) newTask.parentId = params.parentId;
			if (params.description) newTask.description = params.description;
			if (params.activeForm) newTask.activeForm = params.activeForm;
			if (params.blockedBy?.length) newTask.blockedBy = [...new Set(params.blockedBy)];
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };
			return {
				state: { tasks: [...state.tasks, newTask], nextId: state.nextId + 1 },
				op: { kind: "create", taskId: newTask.id },
			};
		}

		case "update": {
			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx]!;
			if (current.status === "deleted")
				return errorResult(state, `task #${current.id} is deleted; tombstones are immutable`);

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.parentId !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation) {
				return errorResult(
					state,
					"update requires at least one mutable field: subject, description, activeForm, status, parentId, owner, metadata, addBlockedBy, or removeBlockedBy",
				);
			}
			if (params.blockedBy !== undefined) {
				return errorResult(state, "use addBlockedBy/removeBlockedBy on update (blockedBy is create-only)");
			}

			let newStatus: TaskStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
				}
				newStatus = params.status;
			}
			if (params.subject !== undefined && !params.subject.trim()) {
				return errorResult(state, "subject must not be blank");
			}
			if (params.status === "completed") {
				const descendant = unfinishedDescendant(state.tasks, current.id);
				if (descendant)
					return errorResult(state, `cannot complete #${current.id}: descendant #${descendant.id} is unfinished`);
			}
			if (params.parentId !== undefined) {
				const unfinished =
					(newStatus !== "completed" && newStatus !== "deleted") ||
					unfinishedDescendant(state.tasks, current.id) !== undefined;
				const error = validateParent(state.tasks, current.id, params.parentId, unfinished);
				if (error) return errorResult(state, error);
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined && Object.keys(params.metadata).length > 0) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.parentId === null) delete updated.parentId;
			else if (params.parentId !== undefined) updated.parentId = params.parentId;
			if (newStatus !== "in_progress") delete updated.activeForm; // stale spinner label
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			let newTasks = [...state.tasks];
			newTasks[idx] = updated;
			if (newStatus === "deleted") newTasks = removeDeletedRelations(newTasks, updated);
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: {
					kind: "update",
					id: updated.id,
					fromStatus: current.status,
					toStatus: newStatus,
					changed: taskChanged(current, updated),
				},
			};
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
				},
			};
		}

		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx]!;
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			const newTasks = [...state.tasks];
			const deleted: Task = { ...current, status: "deleted" };
			newTasks[idx] = deleted;
			return {
				state: { tasks: removeDeletedRelations(newTasks, deleted), nextId: state.nextId },
				op: { kind: "delete", id: current.id, subject: current.subject },
			};
		}

		case "clear": {
			const count = state.tasks.filter((t) => t.status !== "deleted").length;
			return { state: { tasks: [], nextId: 1 }, op: { kind: "clear", count } };
		}
	}
}

// ── sanitize ─────────────────────────────────────────────────────────────

/** Strip terminal control sequences + bidi controls from model-controlled text. */
export function sanitizeTerminalText(value: string): string {
	return value
		.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g, "")
		.replace(/\u001b./g, "")
		.replace(/[\u2028\u2029]/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => (c === "\n" || c === "\r" || c === "\t" ? " " : ""))
		.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

// ── formatting ───────────────────────────────────────────────────────────

function formatReference(tree: TaskTree, id: number): string {
	return tree.label(id, 8) + (tree.parent.has(id) ? ` (id: ${id})` : "");
}

function formatListLine(t: Task, tree: TaskTree): string {
	const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => formatReference(tree, id)).join(", ")}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	const { done, total } = tree.progress(t.id);
	const progress = total ? ` [${done}/${total}]` : "";
	return `[${t.status}] ${formatReference(tree, t.id)} ${sanitizeTerminalText(t.subject)}${progress}${form}${block}`;
}

function formatGetLines(task: Task, state: TaskState): string {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const tree = new TaskTree(state.tasks);
	const { done, total } = tree.progress(task.id);
	const lines = [
		`${formatReference(tree, task.id)} [${task.status}] ${sanitizeTerminalText(task.subject)}${total ? ` [${done}/${total}]` : ""}`,
	];
	const parent = tree.parent.get(task.id);
	lines.push(`  parent: ${parent === undefined ? "root" : formatReference(tree, parent)}`);
	const children = (tree.children.get(task.id) ?? []).filter((child) => child.status !== "deleted");
	if (children.length) lines.push(`  children: ${children.map((child) => formatReference(tree, child.id)).join(", ")}`);
	if (task.description) lines.push(`  description: ${sanitizeTerminalText(task.description)}`);
	if (task.activeForm) lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
	if (task.blockedBy?.length)
		lines.push(`  blockedBy: ${task.blockedBy.map((id) => formatReference(tree, id)).join(", ")}`);
	if (blocks.length) lines.push(`  blocks: ${blocks.map((id) => formatReference(tree, id)).join(", ")}`);
	if (task.owner) lines.push(`  owner: ${sanitizeTerminalText(task.owner)}`);
	return lines.join("\n");
}

export function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create": {
			const t = state.tasks.find((x) => x.id === op.taskId);
			return t
				? `Created ${formatReference(new TaskTree(state.tasks), t.id)}: ${sanitizeTerminalText(t.subject)} (${t.status})`
				: `Created #${op.taskId}`;
		}
		case "update": {
			const label = formatReference(new TaskTree(state.tasks), op.id);
			if (!op.changed) return `No change: ${label} already matches the requested values (status: ${op.toStatus})`;
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			return `Updated ${label}${transition}`;
		}
		case "delete":
			return `Deleted ${formatReference(new TaskTree(state.tasks), op.id)}: ${sanitizeTerminalText(op.subject)}`;
		case "batch": {
			const tree = new TaskTree(state.tasks);
			const lines = op.results.map((result) => {
				const reference = formatReference(tree, result.id);
				if (result.action === "create") {
					const status = result.toStatus && result.toStatus !== "pending" ? ` (${result.toStatus})` : "";
					return `created ${reference}: ${sanitizeTerminalText(result.subject)}${status}`;
				}
				if (result.action === "delete") return `deleted ${reference}: ${sanitizeTerminalText(result.subject)}`;
				if (!result.changed)
					return `no change: ${reference} already matches the requested values (status: ${result.toStatus})`;
				const transition = result.fromStatus !== result.toStatus ? ` (${result.fromStatus} → ${result.toStatus})` : "";
				return `updated ${reference}${transition}`;
			});
			const shown = lines.slice(0, 30);
			if (lines.length > shown.length) shown.push(`+${lines.length - shown.length} more ops`);
			return `Batch: ${op.results.length} ops\n${shown.join("\n")}`;
		}
		case "clear":
			return `Cleared ${op.count} tasks`;
		case "list": {
			let view = state.tasks;
			if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
			if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
			const tree = new TaskTree(state.tasks);
			const lines = view.slice(0, 100).map((task) => formatListLine(task, tree));
			if (view.length > 100) lines.push(`+${view.length - 100} more tasks; use get with a numeric id for details`);
			return lines.length ? lines.join("\n") : "No tasks";
		}
		case "get":
			return formatGetLines(op.task, state);
		case "error":
			return `Error: ${op.message}`;
	}
}

export function buildToolResult(
	action: TaskAction,
	params: TaskMutationParams,
	state: TaskState,
	op: Op,
): { content: Array<{ type: "text"; text: string }>; details: TaskDetails; isError?: boolean } {
	const details: TaskDetails = {
		action,
		params: params as Record<string, unknown>,
		tasks: state.tasks,
		nextId: state.nextId,
		...(op.kind === "error" ? { error: op.message } : {}),
		...(op.kind === "batch" ? { batchResults: op.results } : {}),
	};
	return {
		content: [{ type: "text", text: formatContent(op, state) }],
		details,
		...(op.kind === "error" ? { isError: true } : {}),
	};
}
