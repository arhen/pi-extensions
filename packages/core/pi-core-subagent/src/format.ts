import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import {
	MAX_TASKS,
	type ModelCatalog,
	type ModelPricing,
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
export function modelTag(task: TaskSnapshot): string {
	const ref = [task.provider, task.model, task.thinking].filter(Boolean).join("/");
	return ref ? ` [${ref}]` : "";
}
export function taskLine(task: TaskSnapshot): string {
	return `${statusIcon(task.status)} ${task.agent}${modelTag(task)} · ${taskStatsWithUsage(task)} · ${taskTimer(task)}`;
}
export function colorNums(text: string, theme: Theme): string {
	return text.replace(/((?:\d+(?:\.\d+)?[a-zA-Z]*)+)|([^\d]+)/g, (_m, num?: string, rest?: string) =>
		num ? theme.fg("syntaxNumber", num) : theme.fg("muted", rest ?? ""),
	);
}
function themedTaskLine(task: TaskSnapshot, theme: Theme, activity = ""): string {
	const tail = `${taskStatsWithUsage(task)} · ${taskTimer(task)}`;

	const tag = theme.fg("dim", modelTag(task));
	const gate =
		task.status === "queued" && task.needs?.length ? `${theme.fg("muted", `↳ waits ${task.needs.join(", ")}`)} · ` : "";
	if (TERMINAL.includes(task.status)) {
		return theme.fg("dim", `${statusIcon(task.status)} ${task.agent}${tag} · ${tail}`);
	}

	pulsePhase += 1;
	const name = isTalking(task) ? theme.fg(pulsePhase % 2 === 0 ? "accent" : "dim", `${task.agent} ⇄`) : task.agent;
	return `${statusIcon(task.status)} ${name}${tag} · ${gate}${activity}${colorNums(tail, theme)}`;
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
const NOTE_CAP = 240;
function noteSnippet(note: string): string {
	return note.length > NOTE_CAP ? `${note.slice(0, NOTE_CAP)}…` : note;
}
export function compactLines(run: RunSnapshot): string[] {
	const lines: string[] = [];
	for (const task of run.tasks.slice(0, MAX_TASKS)) {
		lines.push(taskLine(task));
		// a swapped model or toolset changes what the task did, so it cannot stay out of the status view
		if (task.modelNote) lines.push(`   ↳ Model: ${noteSnippet(task.modelNote)}`);
		if (task.toolsNote) lines.push(`   ↳ Tools: ${noteSnippet(task.toolsNote)}`);
	}
	if (run.tasks.length > MAX_TASKS) lines.push(`… +${run.tasks.length - MAX_TASKS} more`);
	return lines;
}
// header + 4 task rows; live tasks are ordered first, so the cap only ever hides finished work
const WIDGET_MAX_LINES = 5;

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
		// live tasks first so the budget never hides work in progress
		const all = runs.flatMap((run) => run.tasks);
		const ordered = [
			...all.filter((t) => !TERMINAL.includes(t.status)),
			...all.filter((t) => TERMINAL.includes(t.status)),
		];
		let shown = 0;
		for (const task of ordered) {
			if (shown >= budget) break;
			shown += 1;
			const activity = task.lastActivity ? `${this.theme.fg("dim", `→ ${task.lastActivity}`)} · ` : "";

			lines.push(
				truncateToWidth(`${this.theme.fg("dim", "├─")} ${themedTaskLine(task, this.theme, activity)}`, width, "…"),
			);
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
			: kind === "completed"
				? `Use subagent_result(runId: "${run.id}", taskId: "${task.id}") for full output.`
				: `Session file kept — resume_subagent(runId: "${run.id}", taskId: "${task.id}", model?: ...) revives it with full context. subagent_result for what it produced so far.`,
	].join("\n");
}
export function makeAskNotice(
	run: RunSnapshot,
	extra: { taskId?: string; agent?: string; question?: string; urgent?: boolean },
): string {
	const who = extra.agent ? `${extra.agent} (${extra.taskId ?? "task"})` : (extra.taskId ?? "a subagent");
	const reply = `reply_subagent(runId: "${run.id}", taskId: "${extra.taskId ?? ""}", message: ...)`;
	return extra.urgent
		? `[URGENT] Subagent ${who} is blocked and cannot continue until you answer: ${extra.question ?? ""}\nAnswer now, before your next step, with ${reply}.`
		: `[not urgent] Subagent ${who} asks: ${extra.question ?? ""}\nIt waits while you keep working — finish your current step first if you want, then answer with ${reply}.`;
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

/** Per-million-token rates, terse. A zero rate reads as "free"; absent rates are "unavailable", not free. */
function priceTag(cost: ModelPricing | undefined): string {
	if (!cost) return "unavailable (provider did not report rates)";
	if (cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0) return "free";
	const rate = (n: number) => (n === 0 ? "free" : `$${n.toFixed(n < 0.01 ? 4 : 2)}`);
	const parts = [`in ${rate(cost.input)}`, `out ${rate(cost.output)}`];
	if (cost.cacheRead === undefined) parts.push("cache-read unavailable");
	else if (cost.cacheRead > 0) parts.push(`cache-read ${rate(cost.cacheRead)}`);
	if (cost.cacheWrite === undefined) parts.push("cache-write unavailable");
	else if (cost.cacheWrite > 0) parts.push(`cache-write ${rate(cost.cacheWrite)}`);
	return `${parts.join(", ")} per Mtok`;
}

/**
 * Render the model catalog as the `subagent_models` tool result. Pure, so the exact text an agent
 * receives is testable: the tool handler holds no formatting of its own. Throws when the list is
 * empty — the SDK tool loop discards a returned `isError` for any `execute` that does not throw.
 */
export function renderModelCatalog(catalog: ModelCatalog): {
	content: { type: "text"; text: string }[];
	details: ModelCatalog;
} {
	if (catalog.models.length === 0) {
		throw new Error(
			`No models can be listed for subagent tasks: ${catalog.unavailable ?? "the model registry returned no models"}. This is not an empty catalog — a task without \`model\` still inherits the session model, but naming one needs the references. Fix model configuration, then retry.`,
		);
	}
	const lines = catalog.models.map((model) =>
		[
			`- model: "${model.reference}"`,
			`    ${model.name}; ${model.contextWindow > 0 ? `${model.contextWindow.toLocaleString("en-US")} context` : "context window unreported"}`,
			`    price: ${priceTag(model.cost)}`,
			model.reasoning
				? `    thinking levels: ${model.thinkingLevels.join(" | ")}`
				: `    thinking: not supported — omit it or pass "off"`,
		].join("\n"),
	);
	const heading =
		catalog.scope === "session"
			? `${catalog.models.length} model(s) enabled for this session. Pass the \`model\` value verbatim in a subagent task:`
			: `${catalog.models.length} model(s) available — this session has no model scoping, so every model with usable credentials is listed. Pass the \`model\` value verbatim in a subagent task:`;
	const suggestion = catalog.preferredDefault
		? `\n\nThis configuration suggests \`model: "${catalog.preferredDefault}"\`. It is a preference, never applied automatically.`
		: "";
	const unlistedDefault = catalog.unlistedDefault
		? `\n\nNOTE: configured default \`${catalog.unlistedDefault}\` is not in the displayed catalog; it is not suggested or applied.`
		: "";
	const hidden =
		catalog.hidden && catalog.hidden > 0
			? `\n\n${catalog.hidden} enabled model(s) are hidden by your model preferences.`
			: "";
	const unused = catalog.unusedPatterns?.length
		? `\n\nNOTE: these preference patterns matched no listed model and did nothing: ${catalog.unusedPatterns.join(", ")}. They may target models that are not enabled.`
		: "";
	const ambiguous = catalog.ambiguous?.length
		? `\n\nDo not pass these references: ${catalog.ambiguous.join(", ")} — ${catalog.reason}.`
		: "";
	const unresolved = catalog.unresolved?.length ? `\n\n${catalog.unresolvedReason}` : "";
	const configError = catalog.configError
		? `\n\nWARNING: the model preferences file could not be used (${catalog.configError}). Continuing with no preferences.`
		: "";
	const billing = "\n\nPrices are pi catalog list rates per Mtok, not a billing quote.";
	return {
		content: [
			{
				type: "text",
				text: `${heading}\n${lines.join("\n")}${suggestion}${unlistedDefault}${hidden}${unused}${ambiguous}${unresolved}${configError}${billing}`,
			},
		],
		details: catalog,
	};
}
