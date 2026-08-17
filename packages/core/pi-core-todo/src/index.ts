/**
 * @arhen/pi-todo — minimal todo extension: `todo` tool, `/todos` command,
 * persistent tree widget. 4-state machine + blockedBy dependencies.
 * Sidecar persistence replaces branch replay (no fork-history replay).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { TodoOverlay } from "./overlay.ts";
import { applyTaskMutation, buildToolResult, sanitizeTerminalText } from "./state.ts";
import {
	clearActiveRenderSession,
	commitState,
	hasSession,
	schedulePersist,
	getActiveRenderSession,
	getRenderState,
	getState,
	restoreSession,
	setActiveRenderSession,
	sid,
} from "./store.ts";
import {
	COMMAND_NAME,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
	type TaskAction,
	type TaskDetails,
	type TaskMutationParams,
	type TaskState,
} from "./types.ts";

const ACTION_GLYPH: Record<TaskAction, string> = { create: "+", update: "→", delete: "×", get: "›", list: "☰", clear: "∅" };
const STATUS_GLYPH: Record<string, string> = { pending: "○", in_progress: "◐", completed: "●", deleted: "⊘" };
const STATUS_COLOR: Record<string, "dim" | "warning" | "success" | "muted"> = { pending: "dim", in_progress: "warning", completed: "success", deleted: "muted" };

const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
	"When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task should be in_progress at a time.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
	"Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
	'To change a task\'s status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. status is the field that changes the task; an update without a mutable field (status or another) is rejected.',
	"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
];

function formatCommandTaskLine(t: { id: number; subject: string; status: string; activeForm?: string; blockedBy?: number[] }, glyph: string): string {
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	const block = t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	return `  ${glyph} #${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}`;
}

export default function (pi: ExtensionAPI) {
	const overlay = new TodoOverlay();

	function refreshOverlay(reset = false): void {
		if (reset) overlay.resetCompletedDisplayState();
		overlay.update();
	}

	pi.registerTool<typeof TodoParamsSchema, TaskDetails>({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
		promptSnippet: DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as unknown as TaskMutationParams;
			const action = typed.action as TaskAction;
			const sessionId = sid(ctx);
			const result = applyTaskMutation(getState(sessionId), action, typed);
			if (action !== "list" && action !== "get" && result.op.kind !== "error") {
				commitState(sessionId, result.state); // L11: read-only actions don't dirty the store
			}
			return buildToolResult(action, typed, result.state, result.op);
		},
		renderCall(args, theme) {
			const glyph = ACTION_GLYPH[args.action] ?? args.action;
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", glyph);
			if (args.action === "create" && args.subject) text += ` ${theme.fg("dim", sanitizeTerminalText(args.subject))}`;
			else if (args.action === "update" && args.id !== undefined) text += ` ${theme.fg("dim", `#${args.id}`)}`;
			else if ((args.action === "get" || args.action === "delete") && args.id !== undefined) text += ` ${theme.fg("dim", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, _opts, theme) {
			const details = result.details;
			const fallback = result.content[0]?.type === "text" ? result.content[0].text : "";
			// get/error results carry single-task/error text in content — don't render the whole list.
			if (!details || details.error || details.action === "get") return new Text(fallback, 0, 0);
			const lines: string[] = [];
			for (const task of details.tasks) {
				// Only hide tombstones for list-without-includeDeleted; delete actions show them.
				const showDeleted = details.action === "delete" || (details.action === "list" && Boolean((details.params as { includeDeleted?: boolean })?.includeDeleted));
				if (task.status === "deleted" && !showDeleted) continue;
				const glyph = theme.fg(STATUS_COLOR[task.status] ?? "dim", STATUS_GLYPH[task.status] ?? "·");
				let subject = theme.fg(task.status === "completed" ? "muted" : "text", sanitizeTerminalText(task.subject));
				if (task.status === "completed" || task.status === "deleted") subject = theme.strikethrough(subject);
				lines.push(`${glyph} ${subject}`);
			}
			return new Text(lines.join("\n") || fallback, 0, 0);
		},
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Show all todos on the current session, grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return; // no ui (print/json modes) — nothing to notify
			const state: TaskState = getState(sid(ctx));
			const visible = state.tasks.filter((t) => t.status !== "deleted");
			if (visible.length === 0) {
				ctx.ui.notify("No todos yet. Ask the agent to add some!", "info");
				return;
			}
			const pending = visible.filter((t) => t.status === "pending");
			const inProgress = visible.filter((t) => t.status === "in_progress");
			const completed = visible.filter((t) => t.status === "completed");
			const header: string[] = [];
			if (completed.length > 0) header.push(`${completed.length}/${visible.length} completed`);
			if (inProgress.length > 0) header.push(`${inProgress.length} in_progress`);
			if (pending.length > 0) header.push(`${pending.length} pending`);
			const lines: string[] = [header.join(" · ")];
			if (pending.length > 0) {
				lines.push("── Pending ──");
				for (const task of pending) lines.push(formatCommandTaskLine(task, "○"));
			}
			if (inProgress.length > 0) {
				lines.push("── In Progress ──");
				for (const task of inProgress) lines.push(formatCommandTaskLine(task, "◐"));
			}
			if (completed.length > 0) {
				lines.push("── Completed ──");
				for (const task of completed) lines.push(formatCommandTaskLine(task, "✓"));
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const id = sid(ctx);
		restoreSession(id);
		if (!ctx.hasUI) return;
		// Re-claim the widget if the previous foreground session is gone.
		if (getActiveRenderSession() === "" || !hasSession(getActiveRenderSession())) setActiveRenderSession(id);
		if (id !== getActiveRenderSession()) return;
		overlay.setUICtx(ctx.ui);
		refreshOverlay(true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		let s: string;
		try {
			s = sid(ctx);
		} catch {
			s = "";
		}
		// M2: keep session data on disk + memory across shutdown/resume — no evict erase.
		if (s === "") return; // anonymous context (no session id): skip dispose + skip persist
		schedulePersist();
		if (s === getActiveRenderSession()) {
			overlay.dispose();
			clearActiveRenderSession();
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		refreshOverlay();
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (sid(ctx) !== getActiveRenderSession()) return; // only the foreground session hides rows
		overlay.hideCompletedTasksFromPreviousTurn();
	});
}
