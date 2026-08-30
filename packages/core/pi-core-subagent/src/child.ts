import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MailboxMessage } from "./mailbox.ts";

export const CHILD_TALK_TOOLS = ["ask_parent", "notify_parent", "send_agent_message", "poll_agent_messages"] as const;

export interface ChildHandlers {
	onAskParent(taskId: string, question: string): Promise<string>;
	onNotifyParent(taskId: string, message: string, level: "info" | "warning" | "error"): void;
	onSendMessage(taskId: string, to: string, text: string): boolean;
	onPollMailbox(taskId: string): MailboxMessage[];
}

export function createChildTools(taskId: string, handlers: ChildHandlers): ToolDefinition[] {
	return [
		{
			name: "ask_parent",
			label: "Ask Parent",
			description:
				"Ask the parent agent a clarifying question and BLOCK until it replies (10 min cap — then proceed with best judgment). Use sparingly — only when you truly cannot proceed without information only the parent has. Prefer figuring it out yourself.",
			promptSnippet: "Ask the parent agent a question when truly blocked.",
			promptGuidelines: [
				"Use ask_parent only as a last resort when blocked on information only the parent has.",
				"Ask one focused question at a time. The parent's reply resumes your work.",
			],
			parameters: Type.Object({
				question: Type.String({ description: "A single, focused question for the parent agent" }),
			}),
			async execute(_toolCallId, params) {
				const { question } = params as { question: string };
				const answer = await handlers.onAskParent(taskId, question);
				return { content: [{ type: "text" as const, text: answer || "(parent gave no answer)" }], details: {} };
			},
		},
		{
			name: "notify_parent",
			label: "Notify Parent",
			description:
				"Send a non-blocking message to the parent agent (a finding, a risk, a heads-up). Your run continues immediately; the parent sees it on its next turn.",
			promptSnippet: "Send the parent a non-blocking update or finding.",
			parameters: Type.Object({
				message: Type.String({ description: "The message content for the parent" }),
				level: Type.Optional(StringEnum(["info", "warning", "error"] as const, { default: "info" })),
			}),
			async execute(_toolCallId, params) {
				const { message, level } = params as { message: string; level?: "info" | "warning" | "error" };
				handlers.onNotifyParent(taskId, message, level ?? "info");
				return { content: [{ type: "text" as const, text: "Sent." }], details: {} };
			},
		},
		{
			name: "send_agent_message",
			label: "Send Agent Message",
			description:
				"Send a non-blocking message to another subagent in this run (delivered to its mailbox; it will see it via poll_agent_messages). Use 'leader' to message the parent instead. Messages are small and bounded — no long transcripts.",
			promptSnippet: "Send a short message to a sibling subagent or the leader.",
			parameters: Type.Object({
				to: Type.String({
					description: "Target task id of another subagent in this run (e.g. task_2), or 'leader' for the parent agent",
				}),
				message: Type.String({ description: "Short message content (keep under ~500 chars)" }),
			}),
			async execute(_toolCallId, params) {
				const { to, message } = params as { to: string; message: string };
				if (!handlers.onSendMessage(taskId, to, message)) {
					return {
						content: [
							{ type: "text" as const, text: `Unknown target '${to}'. Use a sibling task id in this run or 'leader'.` },
						],
						isError: true,
						details: {},
					};
				}
				return { content: [{ type: "text" as const, text: "Sent." }], details: {} };
			},
		},
		{
			name: "poll_agent_messages",
			label: "Poll Agent Messages",
			description:
				"Check your mailbox for messages from sibling subagents. Returns and clears all pending messages. Call it before acting on assumptions about other agents' results.",
			promptSnippet: "Check for messages from other subagents.",
			parameters: Type.Object({}),
			async execute() {
				const messages = handlers.onPollMailbox(taskId);
				if (messages.length === 0) return { content: [{ type: "text" as const, text: "No messages." }], details: {} };
				const body = messages.map((m) => `from ${m.from}: ${m.text}`).join("\n");
				const capped = body.length > 4000 ? body.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, "") : body;
				return { content: [{ type: "text" as const, text: capped }], details: { messages } };
			},
		},
	];
}
