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

const FINAL_OUTPUT_CAP = 24 * 1024;

export function truncateText(text: string, max = FINAL_OUTPUT_CAP): string {
	if (Buffer.byteLength(text, "utf8") <= max) return text;
	let out = text.slice(0, max);
	while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, -1);
	return `${out}\n\n[Output truncated. Full child session is available in the session file.]`;
}
export function getFirstText(message: AssistantMessage): string {
	for (const part of message?.content ?? []) {
		if (part?.type === "text" && typeof part.text === "string") return part.text;
	}
	return "";
}
function fmtTokens(n: number): string {
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
function fmtDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "–";
	const s = Math.max(0, Math.round(ms / 1000));
	return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}
function taskTimer(task: TaskSnapshot): string {
	if (task.startedAt === undefined) return "–";
	const end = task.endedAt ?? Date.now();
	const running = !TERMINAL.includes(task.status);
	return `${running ? "running " : ""}${fmtDuration(end - task.startedAt)}`;
}
function taskStatsWithUsage(task: TaskSnapshot): string {
	const stats = `${task.toolCalls ?? 0} tools`;
	const usage = formatUsage(task.usage);
	return `${stats}${usage ? ` · ${usage}` : ""}`;
}
export function taskLine(task: TaskSnapshot): string {
	return `${statusIcon(task.status)} ${task.agent} · ${taskStatsWithUsage(task)} · ${taskTimer(task)}`;
}
export function colorNums(text: string, theme: Theme): string {
	return text.replace(/((?:\d+(?:\.\d+)?[a-zA-Z]*)+)|([^\d]+)/g, (_m, num?: string, rest?: string) =>
		num ? theme.fg("syntaxNumber", num) : theme.fg("muted", rest ?? ""),
	);
}
function themedTaskLine(task: TaskSnapshot, theme: Theme, activity = ""): string {
	const tail = `${taskStatsWithUsage(task)} · ${taskTimer(task)}`;

	const gate =
		task.status === "queued" && task.needs?.length ? `${theme.fg("muted", `↳ waits ${task.needs.join(", ")}`)} · ` : "";
	if (TERMINAL.includes(task.status)) {
		return theme.fg("dim", `${statusIcon(task.status)} ${task.agent} · ${tail}`);
	}

	pulsePhase += 1;
	const name = isTalking(task) ? theme.fg(pulsePhase % 2 === 0 ? "accent" : "dim", `${task.agent} ⇄`) : task.agent;
	return `${statusIcon(task.status)} ${name} · ${gate}${activity}${colorNums(tail, theme)}`;
}
const ARG_KEYS = ["pattern", "query", "command", "path", "file_path", "filePath", "url", "name", "subject", "task"];
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
	if (cwd && text.startsWith(`${cwd}/`)) text = text.slice(cwd.length + 1);
	return `${verb} ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
}
export function activitySnippet(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

const TALK_TOOLS = ["poll_agent_messages", "send_agent_message", "ask_parent", "notify_parent"];
export function isTalking(task: TaskSnapshot): boolean {
	const a = task.lastActivity?.toLowerCase() ?? "";
	return TALK_TOOLS.some((t) => a.startsWith(t));
}
let pulsePhase = 0;
export function compactLines(run: RunSnapshot): string[] {
	const lines: string[] = [];
	for (const task of run.tasks.slice(0, MAX_TASKS)) {
		lines.push(taskLine(task));
	}
	if (run.tasks.length > MAX_TASKS) lines.push(`… +${run.tasks.length - MAX_TASKS} more`);
	return lines;
}
const WIDGET_MAX_LINES = 10;

export class SubagentsWidget implements Component {
	constructor(
		private readonly getRuns: () => RunSnapshot[],
		private readonly theme: Theme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
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
function worktreeLine(task: TaskSnapshot, siblings?: TaskSnapshot[]): string {
	const parts: string[] = [];
	if (task.branch) {
		const files = task.changedFiles?.length
			? ` (${task.changedFiles.length} file(s): ${truncateText(task.changedFiles.join(", "), 160)})`
			: "";
		parts.push(`Branch: ${task.branch}${files} — merge with \`git merge --no-ff ${task.branch}\` after review.`);

		if (task.stackedOn) {
			parts.push(`Stacked on ${task.stackedOn} — contains that branch's commits, so merging this one brings both.`);
		}

		const overlap = (siblings ?? [])
			.filter((s) => s.id !== task.id && s.branch && !s.stackedOn && !task.stackedOn)
			.flatMap((s) => (s.changedFiles ?? []).filter((f) => task.changedFiles?.includes(f)).map((f) => `${s.id}:${f}`));
		if (overlap.length > 0) {
			parts.push(`CONFLICT RISK — sibling branches touched the same file(s): ${truncateText(overlap.join(", "), 200)}`);
		}
	} else if (task.isolation === "in-place") {
		parts.push(
			`Applied IN PLACE (no branch) — ${task.isolationReason ?? "worktree unavailable"}. Review the working tree directly.`,
		);
	}
	if (task.worktreeError) parts.push(`Worktree: ${task.worktreeError}`);
	return parts.length ? `\n${parts.join("\n")}` : "";
}

export function makeSummary(run: RunSnapshot): string {
	const succeeded = run.tasks.filter((t) => t.status === "completed").length;
	const failed = run.tasks.filter((t) => t.status === "failed").length;
	const aborted = run.tasks.filter((t) => t.status === "aborted").length;
	const done = TERMINAL.includes(run.status) ? "finished" : "running";
	const lines = [
		`Run ${run.id}: Subagents ${run.mode} ${done}: ${succeeded}/${run.tasks.length} succeeded${failed ? `, ${failed} failed` : ""}${aborted ? `, ${aborted} aborted` : ""}.`,
	];
	const usage = formatUsage(run.aggregateUsage);
	if (usage) lines.push(`Usage: ${usage}`);
	for (const task of run.tasks) {
		const edge = task.needs?.length ? ` (${task.id}, needs ${task.needs.join(", ")})` : ` (${task.id})`;
		const fileNote = task.agentFile ? ` [${task.agentFile}]` : "";
		const swap = task.modelNote ? `\nModel: ${task.modelNote}` : "";
		const tools = task.toolsNote ? `\nTools: ${task.toolsNote}` : "";
		lines.push(
			`\n## ${task.agent}${edge}${fileNote} ${statusIcon(task.status)}${swap}${tools}${task.error ? `\nError: ${task.error}` : `\n${truncateText(task.finalText || "(no output)")}`}${worktreeLine(task, run.tasks)}`,
		);
	}

	return truncateText(lines.join("\n"));
}
export function isStartupFailure(task: TaskSnapshot, kind: string): boolean {
	return kind === "failed" && !task.finalText?.trim();
}
export function makeTaskNotice(run: RunSnapshot, task: TaskSnapshot, kind: string): string {
	const goal = truncateText(task.task, 120);
	const detail = task.error ? task.error : truncateText(task.finalText || "(no output)", 200);
	const wt = task.branch
		? ` · branch ${task.branch}${task.changedFiles?.length ? `, ${task.changedFiles.length} file(s)` : ""}`
		: "";

	const src = task.agentFile ? `\nAgent file: ${task.agentFile}${task.model ? ` (model ${task.model})` : ""}` : "";
	const swap = task.modelNote ? `\nModel: ${task.modelNote}` : "";
	const tools = task.toolsNote ? `\nTools: ${task.toolsNote}` : "";
	return [
		`Task ${task.agent} (${task.id}) ${kind} in run ${run.id}: ${detail}${wt}`,
		`Goal: ${goal}${src}${swap}${tools}`,
		isStartupFailure(task, kind)
			? "Never started — stop and diagnose before spawning anything else: a config-level error (model, plan, auth, agent file) fails identically on every respawn."
			: `Use subagent_result(runId: "${run.id}", taskId: "${task.id}") for full output.`,
	].join("\n");
}
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
