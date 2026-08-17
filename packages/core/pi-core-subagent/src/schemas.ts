/** Tool schemas — single source of truth. TaskInput/SubagentParamsShape are
 *  derived from them, so the shapes can never drift from what the model sees. */
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "./manager.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const TaskItem = Type.Object({
	id: Type.Optional(Type.String({ description: "Optional stable task id" })),
	agent: Type.String({
		minLength: 1,
		description:
			"Agent name you invent. Always define the agent inline: prompt (system prompt) + toolset (write: true for write access). Never create agent files.",
	}),
	task: Type.String({ minLength: 1, description: "Task for this agent" }),
	prompt: Type.Optional(
		Type.String({ description: "System prompt defining this agent's behavior. Optional — a minimal default is used." }),
	),
	write: Type.Optional(
		Type.Boolean({
			description: "true = write toolset (read, bash, edit, write); default false = read-only (read, grep, find, ls)",
		}),
	),
	model: Type.Optional(Type.String({ description: "Model override (provider/model-id)" })),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level override" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this task. Default: current project." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Explicit tool allowlist (overrides the toolset)" })),
	maxRuntimeMs: Type.Optional(Type.Number({ description: "Per-task timeout (ms)" })),
	needs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Ids of tasks this one waits for; their outputs are prepended to this prompt.",
		}),
	),
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ minLength: 1, description: "Name you invent for this subagent (single mode)" })),
	task: Type.Optional(Type.String({ minLength: 1, description: "Task (single mode)" })),
	prompt: Type.Optional(Type.String({ description: "System prompt for this agent (single mode)" })),
	write: Type.Optional(Type.Boolean({ description: "true = write toolset; default false = read-only (single mode)" })),
	tools: Type.Optional(
		Type.Array(Type.String(), { description: "Explicit tool allowlist (overrides the toolset) (single mode)" }),
	),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
	chain: Type.Optional(Type.Array(TaskItem, { description: "Sequential tasks; {previous} = prior output" })),
	model: Type.Optional(Type.String({ description: "Model override (single mode)" })),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level override (single mode)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode). Default: current project." })),
	concurrency: Type.Optional(
		Type.Number({ description: `Parallel concurrency (default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY})` }),
	),
	maxRuntimeMs: Type.Optional(
		Type.Number({
			description:
				"Per-task timeout, ms. Omit for no cap (default): tasks run until done, stalled, or user-aborted. Do not add arbitrary caps — only set when a hard bound is genuinely required.",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Fire-and-forget: return immediately with a runId; you'll be notified on completion. Default true — set false when you need the result inline in this turn.",
			default: true,
		}),
	),
	notifyPerTask: Type.Optional(
		Type.Boolean({
			description:
				"Wake you (queued follow-up turn) as each task completes — background runs only, since blocking runs can't be woken mid-tool. Default true.",
			default: true,
		}),
	),
	allowIntercom: Type.Optional(
		Type.Boolean({ description: "Let children ask you questions, notify you, and message sibling subagents" }),
	),
});

/** Derived from the schemas — single source of truth, no hand-maintained mirror. */
export type TaskInput = Static<typeof TaskItem>;
export type SubagentParamsShape = Static<typeof SubagentParams>;

export const RunIdParam = Type.Object({ runId: Type.String({ description: "Run id from subagent()" }) });
export const ResultParam = Type.Object({
	runId: Type.String(),
	taskId: Type.Optional(Type.String({ description: "Specific task id; defaults to all" })),
});
export const AwaitParam = Type.Object({
	runId: Type.String(),
	timeoutMs: Type.Optional(Type.Number({ description: "Max wait (ms); default: until finished" })),
});
export const ReplyParam = Type.Object({
	runId: Type.String(),
	taskId: Type.String(),
	message: Type.String({ description: "Answer for the child" }),
});
export const SteerParam = Type.Object({
	runId: Type.String(),
	taskId: Type.Optional(Type.String({ description: "Specific task id; defaults to all still-running tasks" })),
	message: Type.String({ description: "Steering message to inject into the child's session" }),
});
