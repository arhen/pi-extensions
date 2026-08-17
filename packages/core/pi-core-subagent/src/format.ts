/** Rendering: task lines, usage, the widget, summaries, notices.
 *  Pure + theme-aware — no manager state, no pi runtime. */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import {
	MAX_TASKS,
	type RunSnapshot,
	type RunStatus,
	type TaskSnapshot,
	type TaskStatus,
	TERMINAL,
	type UsageStats,
} from "./types.ts";

/** Cap on a single child's final output (and on full-run summaries). */
export const FINAL_OUTPUT_CAP = 24 * 1024;

export function truncateText(text: string, max = FINAL_OUTPUT_CAP): string {
	if (Buffer.byteLength(text, "utf8") <= max) return text;
	let out = text.slice(0, max);
	while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, -1); // multibyte-safe
	return `${out}\n\n[Output truncated. Full child session is available in the session file.]`;
}
export function getFirstText(message: AssistantMessage): string {
	for (const part of message?.content ?? []) {
		if (part?.type === "text" && typeof part.text === "string") return part.text;
	}
	return "";
}
export function fmtTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}
export function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑ ${fmtTokens(usage.input)}`);
	if (usage.output) parts.push(`↓ ${fmtTokens(usage.output)}`);
	if (usage.cost > 0) parts.push(usage.cost >= 0.0001 ? `$${usage.cost.toFixed(4)}` : "$<0.0001");
	return parts.join(" · ");
}
export function statusIcon(status: TaskStatus | RunStatus): string {
	if (status === "completed") return "✓";
	if (status === "failed") return "✗";
	if (status === "aborted") return "⏹";
	if (status === "awaiting_parent") return "❓";
	if (status === "queued") return "○";
	return "•";
}
export function fmtDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "–";
	const s = Math.max(0, Math.round(ms / 1000));
	return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}
export function taskTimer(task: TaskSnapshot): string {
	if (task.startedAt === undefined) return "–";
	const end = task.endedAt ?? Date.now();
	const running = !TERMINAL.includes(task.status);
	return `${running ? "running " : ""}${fmtDuration(end - task.startedAt)}`;
}
export function taskStatsWithUsage(task: TaskSnapshot): string {
	const stats = `${task.toolCalls ?? 0} tools`;
	const usage = formatUsage(task.usage);
	return `${stats}${usage ? ` · ${usage}` : ""}`;
}
export function taskLine(task: TaskSnapshot): string {
	return `${statusIcon(task.status)} ${task.agent} · ${taskStatsWithUsage(task)} · ${taskTimer(task)}`;
}
/**
 * Numbers take the theme's number color, everything else stays muted — like the footer.
 * Must run on RAW text: styling an already-colored string rewrites the digits
 * inside the ANSI escape codes themselves ("38;2;139;136;122m16 tools").
 */
export function colorNums(text: string, theme: Theme): string {
	// A value keeps its unit: "460.6k" and "2m30s" each color as one token, not digit-by-digit.
	return text.replace(/((?:\d+(?:\.\d+)?[a-zA-Z]*)+)|([^\d]+)/g, (_m, num?: string, rest?: string) =>
		num ? theme.fg("syntaxNumber", num) : theme.fg("muted", rest ?? ""),
	);
}
/**
 * Themed one-liner. Finished tasks dim entirely (stats included); live tasks
 * keep the agent name readable with themed numbers.
 */
export function themedTaskLine(task: TaskSnapshot, theme: Theme, activity = ""): string {
	const tail = `${taskStatsWithUsage(task)} · ${taskTimer(task)}`;
	// Queued task with unmet needs: show the gate it's waiting on instead of empty stats.
	const gate =
		task.status === "queued" && task.needs?.length ? `${theme.fg("muted", `↳ waits ${task.needs.join(", ")}`)} · ` : "";
	if (TERMINAL.includes(task.status)) {
		return theme.fg("dim", `${statusIcon(task.status)} ${task.agent} · ${tail}`);
	}
	// Talking (mailbox/intercom tool in flight): pulse the name accent↔dim; normal otherwise.
	pulsePhase += 1;
	const name = isTalking(task) ? theme.fg(pulsePhase % 2 === 0 ? "accent" : "dim", `${task.agent} ⇄`) : task.agent;
	return `${statusIcon(task.status)} ${name} · ${gate}${activity}${colorNums(tail, theme)}`;
}
/**
 * Human-readable activity line: "Read src/index.ts", "Grep wrapSingleLine".
 * ponytail: picks the first interesting string arg instead of a per-tool table —
 * unknown/custom tools then read fine too. Add a case only if one reads badly.
 */
// Order matters: the most specific arg wins (grep's pattern beats its path).
export const ARG_KEYS = [
	"pattern",
	"query",
	"command",
	"path",
	"file_path",
	"filePath",
	"url",
	"name",
	"subject",
	"task",
];
export function describeCall(toolName: string, args: unknown, cwd?: string): string {
	const verb = toolName.charAt(0).toUpperCase() + toolName.slice(1);
	const obj = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
	if (!obj) return verb;
	let value = ARG_KEYS.map((k) => obj[k]).find((v) => typeof v === "string" && v.trim() !== "") as string | undefined;
	if (value === undefined) {
		value = Object.values(obj).find((v) => typeof v === "string" && v.trim() !== "") as string | undefined;
	}
	if (value === undefined) return verb;
	let text = value.replace(/\s+/g, " ").trim();
	if (cwd && text.startsWith(`${cwd}/`)) text = text.slice(cwd.length + 1); // absolute paths inside the task cwd read as noise
	return `${verb} ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
}
export function activitySnippet(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

/** Mailbox/intercom tools — while one is the task's last activity, the agent is "talking". */
export const TALK_TOOLS = ["poll_agent_messages", "send_agent_message", "ask_parent", "notify_parent"];
export function isTalking(task: TaskSnapshot): boolean {
	const a = task.lastActivity?.toLowerCase() ?? "";
	return TALK_TOOLS.some((t) => a.startsWith(t));
}
let pulsePhase = 0; // flips per render; talking agents alternate between the two name styles
/** Static compact lines (tool-result stream, subagent_status, /subagents). */
export function compactLines(run: RunSnapshot): string[] {
	const lines: string[] = [];
	for (const task of run.tasks.slice(0, MAX_TASKS)) {
		lines.push(taskLine(task));
	}
	if (run.tasks.length > MAX_TASKS) lines.push(`… +${run.tasks.length - MAX_TASKS} more`);
	return lines;
}
/**
 * Above-editor widget, todo-tree style:
 *   ● Subagents (0/1)
 *   ├─ • code-sleuth · 4 tools · 12s
 *   │    → read src/auth.ts
 *   └─ ✓ reviewer · 6 tools · 44s
 * Static icons (no animation); latest activity + tool count + runtime per agent.
 */
export const WIDGET_MAX_LINES = 10;

export class SubagentsWidget implements Component {
	constructor(
		private readonly getRuns: () => RunSnapshot[],
		private readonly theme: Theme,
	) {}

	invalidate(): void {
		// no cached strings; render() reads live state
	}

	render(width: number): string[] {
		// ONE flat tree: every run's tasks concatenated under a single heading.
		// Whether the model spawned N runs or one tasks[] call, the pane reads the same.
		const runs = this.getRuns().filter((r) => r.tasks.length > 0);
		if (runs.length === 0) return [];
		const total = runs.reduce((n, r) => n + r.tasks.length, 0);
		const done = runs.reduce((n, r) => n + r.tasks.filter((t) => TERMINAL.includes(t.status)).length, 0);
		const live = total - done;
		const head = live > 0 ? "accent" : "dim";
		const lines = [
			truncateToWidth(
				`${this.theme.fg(head, live > 0 ? "●" : "○")} ${this.theme.fg(head, `Subagents (${done}/${total})`)}`,
				width,
				"…",
			),
		];
		const budget = WIDGET_MAX_LINES - 1;
		let shown = 0;
		outer: for (const run of runs) {
			for (const task of run.tasks) {
				if (shown >= budget) break outer;
				shown += 1;
				const activity = task.lastActivity ? `${this.theme.fg("dim", `→ ${task.lastActivity}`)} · ` : "";
				// Per-TASK status drives dimming: a finished agent stays dim even while siblings run.
				lines.push(
					truncateToWidth(`${this.theme.fg("dim", "├─")} ${themedTaskLine(task, this.theme, activity)}`, width, "…"),
				);
			}
		}
		const hidden = total - shown;
		if (hidden > 0) {
			lines.push(`${this.theme.fg("dim", "└─")} ${this.theme.fg("dim", `+${hidden} more`)}`);
		} else if (lines.length > 1) {
			const last = lines[lines.length - 1];
			if (last) lines[lines.length - 1] = last.replace("├─", "└─");
		}
		return lines;
	}
}
/** Blocking-call summary: full text, because the model asked for it. */
export function makeSummary(run: RunSnapshot): string {
	const succeeded = run.tasks.filter((t) => t.status === "completed").length;
	const failed = run.tasks.filter((t) => t.status === "failed").length;
	const aborted = run.tasks.filter((t) => t.status === "aborted").length;
	const done = TERMINAL.includes(run.status) ? "finished" : "running";
	const lines = [
		`Run ${run.id}: Subagents ${run.mode}${run.background ? " (background)" : ""} ${done}: ${succeeded}/${run.tasks.length} succeeded${failed ? `, ${failed} failed` : ""}${aborted ? `, ${aborted} aborted` : ""}.`,
	];
	const usage = formatUsage(run.aggregateUsage);
	if (usage) lines.push(`Usage: ${usage}`);
	for (const task of run.tasks) {
		// Edges are named so the leader can compare what it delegated against what came back.
		const edge = task.needs?.length ? ` (${task.id}, needs ${task.needs.join(", ")})` : ` (${task.id})`;
		lines.push(
			`\n## ${task.agent}${edge} ${statusIcon(task.status)}${task.error ? `\nError: ${task.error}` : `\n${truncateText(task.finalText || "(no output)")}`}`,
		);
	}
	// Ceiling on the WHOLE summary — 16 tasks × 24KB would otherwise flood the parent context.
	return truncateText(lines.join("\n"));
}
/** Per-task notice: one task's outcome, small. Full output stays out of parent context. */
export function makeTaskNotice(run: RunSnapshot, task: TaskSnapshot, kind: string): string {
	const detail = task.error ? task.error : truncateText(task.finalText || "(no output)", 200);
	return [
		`Task ${task.agent} (${task.id}) ${kind} in run ${run.id}: ${detail}`,
		`Use subagent_result(runId: "${run.id}", taskId: "${task.id}") for full output.`,
	].join("\n");
}
/** Notification: 3 lines max. Full output stays out of parent context. */
export function makeNotice(run: RunSnapshot, kind: string): string {
	const lines = [
		`Background subagent run ${run.id} ${kind}: ${run.tasks.filter((t) => t.status === "completed").length}/${run.tasks.length} succeeded.`,
	];
	for (const task of run.tasks) {
		lines.push(`- ${task.agent}: ${task.status}${task.error ? ` — ${truncateText(task.error, 200)}` : ""}`);
	}
	lines.push(`Use subagent_result(runId: "${run.id}") for full output.`);
	return lines.join("\n");
}
