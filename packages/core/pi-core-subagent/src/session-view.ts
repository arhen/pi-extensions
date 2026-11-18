import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
	AssistantMessageComponent,
	CustomEditor,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getMarkdownTheme,
	getSelectListTheme,
	type KeybindingsManager,
	parseSessionEntries,
	type Theme,
	type ThemeColor,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	Spacer,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { PeekTask } from "./peek.ts";
import type { TaskRef } from "./types.ts";

const POLL_MS = 700;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BUILTIN_TOOLS: Record<string, (cwd: string) => any> = {
	bash: createBashToolDefinition,
	read: createReadToolDefinition,
	edit: createEditToolDefinition,
	write: createWriteToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text")
		.map((part) => part.text)
		.join("\n");
}

// Mirrors pi-senja's footer so the subagent view reads like the leader's.
const PROVIDER_COLOR: Record<string, ThemeColor> = {
	anthropic: "accent",
	openai: "success",
	"openai-codex": "success",
	google: "warning",
	"google-vertex": "warning",
	"amazon-bedrock": "thinkingHigh",
	"github-copilot": "mdLink",
	deepseek: "thinkingLow",
	xai: "error",
	groq: "error",
	"opencode-go": "accent",
};
const stressColor = (pct: number): ThemeColor => (pct >= 90 ? "error" : pct >= 70 ? "warning" : "accent");

function tokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export interface ChildStats {
	cwd: string;
	provider?: string;
	model?: string;
	input: number;
	output: number;
	cost: number;
	/** Prompt size of the latest response: what the child's context holds now. */
	context: number;
}

/** Child transcript drawn with pi's own message components, so it reads like a normal session. */
export function transcript(
	sessionFile: string,
	tui: TUI,
	hideThinking: boolean,
): { root: Container; stats: ChildStats } {
	const root = new Container();
	let entries: any[] = [];
	try {
		entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
	} catch {}
	const cwd = entries[0]?.type === "session" ? entries[0].cwd : process.cwd();
	const stats: ChildStats = { cwd, input: 0, output: 0, cost: 0, context: 0 };
	const pending = new Map<string, ToolExecutionComponent>();
	const md = getMarkdownTheme();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			const text = userText(message.content);
			if (!text) continue;
			root.addChild(new Spacer(1));
			root.addChild(new UserMessageComponent(text, md));
		} else if (message.role === "assistant") {
			const usage = message.usage;
			if (usage) {
				stats.input += usage.input ?? 0;
				stats.output += usage.output ?? 0;
				stats.cost += usage.cost?.total ?? 0;
				stats.context = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			}
			stats.provider = message.provider ?? stats.provider;
			stats.model = message.model ?? stats.model;
			root.addChild(new AssistantMessageComponent(message, hideThinking, md));
			for (const block of message.content ?? []) {
				if (block.type !== "toolCall") continue;
				const tool = new ToolExecutionComponent(
					block.name,
					block.id,
					block.arguments,
					{},
					BUILTIN_TOOLS[block.name]?.(cwd),
					tui,
					cwd,
				);
				root.addChild(tool);
				pending.set(block.id, tool);
			}
		} else if (message.role === "toolResult") {
			pending.get(message.toolCallId)?.updateResult(message);
		}
	}
	return { root, stats };
}

/** pi's editor with the subagent's working state in its top border, like the leader's. */
class ChildEditor extends CustomEditor {
	status: (() => string | undefined) | undefined;

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const text = this.status?.();
		if (!text || width < visibleWidth(text) + 5) return super.renderTopBorder(width, hiddenLineCount);
		return this.borderColor("── ") + text + this.borderColor(` ${"─".repeat(width - visibleWidth(text) - 4)}`);
	}
}

export interface SessionViewOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	getTasks: () => PeekTask[];
	startTask: TaskRef;
	leaderBusy: () => boolean;
	hideThinking: boolean;
	contextWindow: (provider: string | undefined, model: string | undefined) => number | undefined;
	/** Deliver a typed message to the task; returns a short outcome for the footer. */
	send: (task: PeekTask, message: string) => string;
	close: () => void;
}

/**
 * A subagent session in the whole window, with pi's editor talking to that subagent. Not a real
 * session switch: pi's switchSession aborts the active turn and session_shutdown kills every
 * child, so the leader and the subagents keep running underneath and Esc returns to the leader.
 */
export function createSessionView(opts: SessionViewOptions) {
	const { tui, theme } = opts;
	let target = opts.startTask;
	let fromBottom = 0;
	let viewport = 10;
	let hideThinking = opts.hideThinking;
	let cache: { key: string; lines: string[]; stats: ChildStats; root: Container } | undefined;
	let layout: { width: number; head: number; pad: number; start: number; end: number } | undefined;
	let notice: { text: string; until: number } | undefined;
	const timer = setInterval(() => tui.requestRender(), POLL_MS / 7);

	const current = () => {
		const tasks = opts.getTasks();
		// Task ids repeat across runs, so identity is the pair — never the id alone.
		const index = tasks.findIndex((t) => t.runId === target.runId && t.taskId === target.taskId);
		return { tasks, index, task: index === -1 ? undefined : tasks[index] };
	};

	const editor = new ChildEditor(
		tui,
		{ borderColor: (s) => theme.fg("borderMuted", s), selectList: getSelectListTheme() },
		opts.keybindings,
		{ paddingX: 0 },
	);
	editor.status = () => {
		const task = current().task;
		if (!task?.running) return undefined;
		const frame = SPINNER[Math.floor(Date.now() / 80) % SPINNER.length];
		const since = task.startedAt ? ` ${Math.floor((Date.now() - task.startedAt) / 1000)}s` : "";
		return `${theme.fg("accent", frame ?? "")} ${theme.fg("muted", `${task.agent} is working…${since}`)}`;
	};
	editor.onAction("app.thinking.toggle", () => {
		hideThinking = !hideThinking;
		cache = undefined;
		tui.requestRender();
	});
	editor.onSubmit = (value) => {
		const message = value.trim();
		const { task } = current();
		if (!message || !task) return;
		editor.addToHistory(message);
		fromBottom = 0;
		notice = { text: `${task.agent}: ${opts.send(task, message)}`, until: Date.now() + 4000 };
		tui.requestRender();
	};

	const body = (task: PeekTask | undefined, width: number) => {
		if (!task?.sessionFile) return { lines: [theme.fg("dim", "  (agent has not started yet)")], stats: undefined };
		let size = 0;
		try {
			size = statSync(task.sessionFile).size;
		} catch {}
		const key = `${task.sessionFile}:${size}:${width}:${hideThinking}`;
		if (cache?.key === key) return cache;
		const previous = cache?.key.startsWith(`${task.sessionFile}:`) ? cache.lines.length : undefined;
		const { root, stats } = transcript(task.sessionFile, tui, hideThinking);
		const lines = root.render(width);
		// Hold the reading position while new output lands below it.
		if (fromBottom > 0 && previous !== undefined) fromBottom += Math.max(0, lines.length - previous);
		cache = { key, lines, stats, root };
		return cache;
	};
	const switchTask = (step: number) => {
		const { tasks, index } = current();
		if (tasks.length === 0) return;
		const next = tasks[(Math.max(0, index) + step + tasks.length) % tasks.length]!;
		target = { runId: next.runId, taskId: next.taskId };
		fromBottom = 0;
	};
	const scroll = (rows: number) => {
		fromBottom = Math.max(0, fromBottom + rows);
	};

	const footer = (task: PeekTask | undefined, stats: ChildStats | undefined, width: number): string[] => {
		const dim = (s: string) => theme.fg("dim", s);
		const home = homedir();
		const cwd = stats?.cwd.startsWith(home) ? `~${stats.cwd.slice(home.length)}` : (stats?.cwd ?? "");
		const model = [
			stats?.provider && theme.fg(PROVIDER_COLOR[stats.provider.toLowerCase()] ?? "muted", stats.provider),
			stats?.model && theme.fg("text", stats.model),
			task?.thinking && theme.getThinkingBorderColor(task.thinking as never)(task.thinking),
		]
			.filter(Boolean)
			.join(dim(" ▪ "));
		const left1 = truncateToWidth(theme.fg("accent", cwd), Math.max(0, width - visibleWidth(model) - 1), "…");
		const gap1 = Math.max(1, width - visibleWidth(left1) - visibleWidth(model));
		const parts = stats
			? [
					`${dim("in")} ${theme.fg("accent", `↑${tokens(stats.input)}`)}`,
					`${dim("out")} ${theme.fg("success", `↓${tokens(stats.output)}`)}`,
					...(stats.cost > 0 ? [`${dim("cost")} ${theme.fg("warning", `$${stats.cost.toFixed(3)}`)}`] : []),
				]
			: [];
		const window = opts.contextWindow(stats?.provider, stats?.model);
		let ctx = "";
		if (stats && window && stats.context > 0) {
			const pct = (stats.context / window) * 100;
			const pctText = theme.fg(stressColor(pct), `${pct.toFixed(1)}%`);
			const sizes = `${theme.fg("text", tokens(stats.context))}${dim("/")}${theme.fg("text", tokens(window))}`;
			const barWidth = Math.max(6, Math.min(16, width - visibleWidth(pctText) - visibleWidth(sizes) - 6));
			const filled = Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth)));
			const bar = `${dim("[")}${theme.fg(stressColor(pct), "█".repeat(filled))}${dim("░".repeat(barWidth - filled))}${dim("]")}`;
			ctx = `${bar} ${pctText} ${dim("▪")} ${sizes}`;
		}
		const left2 = parts.join(dim(" | "));
		const gap2 = Math.max(1, width - visibleWidth(left2) - visibleWidth(ctx));
		return [
			truncateToWidth(`${left1}${" ".repeat(gap1)}${model}`, width, "…"),
			truncateToWidth(`${left2}${" ".repeat(gap2)}${ctx}`, width, "…"),
		];
	};

	return {
		get focused() {
			return editor.focused;
		},
		set focused(value: boolean) {
			editor.focused = value;
		},
		render(width: number): string[] {
			const rows = tui.terminal.rows;
			const { tasks, index, task } = current();
			const busy = opts.leaderBusy();
			const bar = theme.bg(
				"selectedBg",
				truncateToWidth(
					` ${theme.fg("accent", "◀ Leader")} ${busy ? theme.fg("warning", "● working") : theme.fg("success", "○ idle")}${theme.fg("dim", " · esc back · tab agent · pgup/pgdn scroll · enter send · shift+enter newline")}`,
					width,
					"…",
					true,
				),
			);
			const crumb = task
				? ` ${theme.fg("accent", theme.bold(`subagent: ${task.agent}`))} ${theme.fg("muted", `${task.status} · ${index + 1}/${tasks.length}`)}`
				: theme.fg("dim", " (no subagents)");
			const head = [bar, truncateToWidth(crumb, width, "…", true)];
			const { lines, stats } = body(task, width);
			const input = editor.render(width);
			const foot = footer(task, stats, width);
			if (notice && Date.now() > notice.until) notice = undefined;
			const status = notice
				? theme.fg("accent", ` ${notice.text}`)
				: fromBottom > 0
					? theme.fg("warning", ` ↑ ${fromBottom} lines above live · pgdn / end → live`)
					: task && !task.running
						? theme.fg("dim", " end of session · typing resumes it")
						: "";
			viewport = Math.max(1, rows - head.length - 1 - input.length - foot.length);
			fromBottom = Math.min(fromBottom, Math.max(0, lines.length - viewport));
			const end = lines.length - fromBottom;
			const window = lines.slice(Math.max(0, end - viewport), end);
			// Blank filler above a short transcript shifts every row; the click mapping must know it.
			layout = {
				width,
				head: head.length,
				pad: Math.max(0, viewport - window.length),
				start: Math.max(0, end - viewport),
				end,
			};
			while (window.length < viewport) window.unshift("");
			return [
				...head,
				...window.map((l) => truncateToWidth(l, width, "", true)),
				truncateToWidth(status, width, "…", true),
				...input,
				...foot,
			];
		},
		handleInput(data: string): void {
			if (matchesKey(data, Key.escape) && !editor.isShowingAutocomplete()) {
				opts.close();
				return;
			}
			const empty = editor.getText() === "";
			if (matchesKey(data, Key.tab) && !editor.isShowingAutocomplete()) switchTask(1);
			else if (matchesKey(data, Key.shift("tab"))) switchTask(-1);
			else if (matchesKey(data, Key.pageUp)) scroll(viewport);
			else if (matchesKey(data, Key.pageDown)) scroll(-viewport);
			else if (empty && matchesKey(data, Key.home)) scroll(Number.MAX_SAFE_INTEGER);
			else if (empty && matchesKey(data, Key.end)) fromBottom = 0;
			else editor.handleInput(data);
			tui.requestRender();
		},
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			if (event.type === "wheel" && event.wheelDelta) {
				scroll(-event.wheelDelta);
				return { handled: true };
			}
			if (event.type !== "click" || event.button !== "left" || !layout || !cache || layout.width !== event.width)
				return undefined;
			// The transcript is cached as flat lines; hand the click back to its own components, which
			// is what makes the thinking blocks (MouseRegion) and anything else clickable.
			const y = layout.start + event.y - layout.head - layout.pad;
			if (event.y < layout.head + layout.pad || y >= layout.end || y < 0) return undefined;
			const before = cache.lines.length;
			if (!cache.root.handleMouse({ ...event, y, height: before })) return undefined;
			cache.lines = cache.root.render(layout.width);
			// Keep the clicked line under the pointer as the block grows or shrinks.
			fromBottom = Math.max(0, fromBottom + cache.lines.length - before);
			tui.requestRender();
			return { handled: true };
		},
		invalidate(): void {
			cache = undefined;
			editor.invalidate();
		},
		dispose(): void {
			clearInterval(timer);
		},
	};
}
