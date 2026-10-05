import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TodoOverlay } from "./overlay.ts";
import { applyTaskMutation, buildToolResult, sanitizeTerminalText } from "./state.ts";
import {
	clearActiveRenderSession,
	commitState,
	hasSession,
	schedulePersist,
	getActiveRenderSession,
	getState,
	restoreSession,
	setActiveRenderSession,
	sid,
} from "./store.ts";
import { TaskTree } from "./tree.ts";
import { BoundedLines, TodoResultPreview } from "./view.ts";
import { TodoViewer } from "./viewer.ts";
import {
	COMMAND_NAME,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
	type TaskAction,
	type TaskDetails,
	type TaskMutationParams,
} from "./types.ts";

const ACTION_GLYPH: Record<TaskAction, string> = { create: "+", update: "→", batch: "≡", delete: "×", get: "›", list: "☰", clear: "∅" };

const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
	"When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task should be in_progress at a time.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
	"Batch related changes in one call: action:'batch' with an ordered ops array of create/update/delete. The batch is atomic — any failed op aborts the whole batch and nothing is applied. A create op may set ref (alias); later ops address it via id, parentId, or blockedBy, so a whole list or subtree is created in a single call.",
	"Keep the list live while you work — it is the user's view of what is actually happening. When reality changes, change the list in the same turn: add the new step, split a step into child subtasks via parentId, reword or re-scope an item, or cancel dropped work.",
	"Cancel dropped or superseded work by deleting it (delete is a tombstone). Never leave an item pending, in_progress or blocked after it stopped being true — a stale item tells the user the wrong thing about progress.",
	"Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
	'To change a task\'s status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. status is the field that changes the task; an update without a mutable field (status or another) is rejected.',
	"Use parentId on create/update for optional nested subtasks at any depth. Omit it for flat todos; set parentId:null on update to move a task to the root. Use stable numeric ids in tool arguments; hierarchical labels such as #7.a.b are display labels, not ids.",
	"Statuses stay explicit: keep the parent pending while working on a child, then complete it after all live descendants are completed. Parent [done/total] counters count direct children only, never grandchildren. Deleting a parent promotes its live children; it does not delete the subtree.",
	"Use blockedBy to express dependencies (A is blocked by B), not nesting. On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
];

export default function (pi: ExtensionAPI) {
	const overlay = new TodoOverlay();

	function refreshOverlay(reset = false): void {
		if (reset) overlay.resetCompletedDisplayState();
		overlay.update();
	}

	pi.registerTool<typeof TodoParamsSchema, TaskDetails, { label?: string }>({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: "Manage flat or arbitrarily nested todos with optional parentId. Actions: create, update, batch, list, get, delete (tombstone), clear. batch applies ordered create/update/delete ops atomically; each create op may declare a ref alias for later ops. Statuses are explicit: pending → in_progress → completed, plus deleted. Parent completion requires all live descendants completed. Numeric ids stay stable; UI labels use #7.a.b and direct-child [done/total] counters. Use blockedBy for dependencies independently of nesting.",
		promptSnippet: "Manage flat or nested todos to track multi-step progress",
		promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as unknown as TaskMutationParams;
			const action = typed.action as TaskAction;
			const sessionId = sid(ctx);
			const result = applyTaskMutation(getState(sessionId), action, typed);
			if (action !== "list" && action !== "get" && result.op.kind !== "error") commitState(sessionId, result.state);
			return buildToolResult(action, typed, result.state, result.op);
		},
		renderCall(args, theme, context) {
			return new BoundedLines(() => {
				let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", ACTION_GLYPH[args.action] ?? args.action);
				const label = context.state.label ?? (args.id !== undefined ? new TaskTree(getState(getActiveRenderSession()).tasks).label(args.id, 4) : undefined);
				if (label) text += ` ${theme.fg("dim", label)}`;
				if (args.action === "create" && args.subject) text += ` ${theme.fg("dim", sanitizeTerminalText(args.subject))}`;
				if (args.action === "batch") {
					const ops = args.ops ?? [];
					const counts = new Map<string, number>();
					for (const op of ops) counts.set(op.action, (counts.get(op.action) ?? 0) + 1);
					const breakdown = [...counts].map(([kind, count]) => `${count} ${kind}`).join(", ");
					text += ` ${theme.fg("dim", `${ops.length} ops${breakdown ? ` · ${breakdown}` : ""}`)}`;
				}
				return [text];
			}, () => 1, theme);
		},
		renderResult(result, opts, theme, context) {
			const details = result.details;
			if (details && !details.error) {
				const id = details.action === "create" ? details.nextId - 1 : details.params.id;
				if (typeof id === "number") {
					const label = new TaskTree(details.tasks).label(id, 4);
					if (context.state.label !== label) {
						context.state.label = label;
						// Pi can rebuild the tool container synchronously from its invalidator.
						queueMicrotask(context.invalidate);
					}
				}
			}
			const fallback = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new TodoResultPreview(details, fallback, theme, () => overlay.terminalRows, opts.expanded);
		},
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Browse the todo tree: scroll, expand, and collapse branches",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos tree browser requires interactive mode", "info");
				return;
			}
			const sessionId = sid(ctx);
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new TodoViewer(tui, theme, () => getState(sessionId), done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%", margin: 0 },
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const id = sid(ctx);
		restoreSession(id);
		if (ctx.mode !== "tui") return;
		if (getActiveRenderSession() === "" || !hasSession(getActiveRenderSession())) setActiveRenderSession(id);
		if (id !== getActiveRenderSession()) return;
		overlay.setUICtx(ctx.ui);
		refreshOverlay(true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionId = sid(ctx);
		if (!sessionId) return;
		schedulePersist();
		if (sessionId === getActiveRenderSession()) {
			overlay.dispose();
			clearActiveRenderSession();
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName === TOOL_NAME && !event.isError) refreshOverlay();
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (sid(ctx) === getActiveRenderSession()) overlay.hideCompletedTasksFromPreviousTurn();
	});
}
