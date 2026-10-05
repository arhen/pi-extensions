import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";
export const COMMAND_NAME = "todos";
export const WIDGET_KEY = "todos";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TaskAction = "create" | "update" | "batch" | "list" | "get" | "delete" | "clear";

/** One step of a `batch` action. `ref` aliases a task created earlier in the same batch. */
export type TaskOpAction = "create" | "update" | "delete";

export interface TaskOp {
	action: TaskOpAction;
	ref?: string;
	id?: number | string;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	parentId?: number | string | null;
	blockedBy?: Array<number | string>;
	addBlockedBy?: Array<number | string>;
	removeBlockedBy?: Array<number | string>;
	owner?: string;
	metadata?: Record<string, unknown>;
}

/** Resolved outcome of one batch op, used for rendering and details. */
export interface BatchOpResult {
	action: TaskOpAction;
	id: number;
	subject: string;
	fromStatus?: TaskStatus;
	toStatus?: TaskStatus;
	changed?: boolean;
}

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	parentId?: number;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

/** Tool result details: state snapshot after the action. */
export interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
	batchResults?: BatchOpResult[];
}

export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	parentId?: number | null;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	includeDeleted?: boolean;
	ops?: TaskOp[];
}

export interface TaskState {
	tasks: Task[];
	nextId: number;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

export const TaskOpSchema = Type.Object({
	action: StringEnum(["create", "update", "delete"] as const),
	ref: Type.Optional(
		Type.String({
			description:
				"Create only: alias for the new task, e.g. 'setup'. Later ops in the batch target it through id, parentId, blockedBy, addBlockedBy, or removeBlockedBy. Forward/self references fail.",
		}),
	),
	id: Type.Optional(
		Type.Union([Type.Number(), Type.String()], {
			description: "Task to update/delete: numeric id, or a ref defined by an earlier create op in this batch (required for update/delete)",
		}),
	),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({ description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')" }),
	),
	status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "deleted"] as const, { description: "Set this task's status (update)" })),
	parentId: Type.Optional(
		Type.Union([Type.Number(), Type.String(), Type.Null()], {
			description: "Parent (create/update): numeric id, a ref defined by an earlier create op, or null for a root task",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Union([Type.Number(), Type.String()]), { description: "Initial blockedBy ids or refs (create only)" }),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Union([Type.Number(), Type.String()]), { description: "Ids or refs to add to blockedBy (update only, additive merge)" }),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Union([Type.Number(), Type.String()]), { description: "Ids or refs to remove from blockedBy (update only, additive merge)" }),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary metadata; pass null value for a key to delete that key on update" }),
	),
});

export const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "batch", "list", "get", "delete", "clear"] as const),
	ops: Type.Optional(
		Type.Array(TaskOpSchema, {
			minItems: 1,
			maxItems: 100,
			description:
				"Ordered create/update/delete ops for action:batch. Applied sequentially to the accumulated list; the first failure aborts the whole batch and applies nothing. Create ops may declare ref aliases for later ops.",
		}),
	),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description:
				"Set this task's status (update): one of pending, in_progress, completed, deleted. When action is list, filters returned tasks by this status.",
		}),
	),
	parentId: Type.Optional(
		Type.Union([Type.Number(), Type.Null()], {
			description: "Parent task id (create/update). Pass null for a root task; omit to leave parent unchanged on update. Statuses are explicit: a parent cannot complete until all live descendants complete.",
		}),
	),
	blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Initial blockedBy ids (create only)" })),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), { description: "Task ids to add to blockedBy (update only, additive merge)" }),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), { description: "Task ids to remove from blockedBy (update only, additive merge)" }),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Arbitrary metadata; pass null value for a key to delete that key on update",
		}),
	),
	id: Type.Optional(Type.Number({ description: "Task id (required for update, get, delete)" })),
	includeDeleted: Type.Optional(
		Type.Boolean({ description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false." }),
	),
});

