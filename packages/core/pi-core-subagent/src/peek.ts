/**
 * Peek pane — quick, read-only look at what subagents are doing.
 *
 * shift+↑/↓ (or j/k) move between agents, enter opens a live tail of that
 * child's session file, esc goes back / closes. Never touches run state:
 * no abort except the explicit x + y confirmation.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Tail window: last 64KB of the child session file is plenty for a peek. */
const TAIL_BYTES = 64 * 1024;
const POLL_MS = 700;
const TAIL_ROWS = 18;

export interface PeekTask {
	runId: string;
	taskId: string;
	agent: string;
	status: string;
	running: boolean;
	sessionFile?: string;
	line: string; // pre-rendered stats line from the caller
}

function readTail(path: string): string {
	const fd = openSync(path, "r");
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		return buf.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** Reasoning markup is the model talking to itself, and empty `<think></think>`
 *  pairs are the commonest single line in a transcript — they filled the pane with
 *  rows carrying no information at all. */
function stripThinking(text: string): string {
	return text
		.replace(/<think>[\s\S]*?<\/think>/g, " ")
		.replace(/<\/?(?:think|thinking|reasoning)>/g, " ")
		.trim();
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping real terminal escapes is the point
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: same
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Tool output is terminal output: it carries colour escapes and carriage returns
 *  that corrupt the pane's own styling (stray `[0m` mid-row, cursor jumps). */
function clip(text: string, max: number): string {
	const flat = text.replace(ANSI, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Long absolute paths are almost entirely prefix. The tail is what identifies
 *  the file, so shorten from the left and keep the last segments. */
function shortenPath(text: string): string {
	return text.replace(/(?:\/[\w.@+-]+){3,}/g, (path) => {
		const parts = path.split("/").filter(Boolean);
		return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
	});
}

const PATH_ARGS = ["path", "file", "filePath", "command", "pattern", "query", "url", "task", "subject"];

/** The argument that says WHAT a call does. Object.values() order is insertion
 *  order, so the old "first string wins" picked `oldText` blobs over `path`. */
function callSummary(args: Record<string, unknown> | undefined): string {
	for (const key of PATH_ARGS) {
		const value = args?.[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	const first = Object.values(args ?? {}).find((v) => typeof v === "string" && v.trim() !== "");
	return typeof first === "string" ? first : "";
}

export type PeekLine = { gutter: string; text: string; kind: "call" | "result" | "error" | "say" };

/** One session-file entry → display lines. A turn with 4 tool calls is 4 lines:
 *  keeping only the first hid the parallel calls that explain what the child did. */
function eventLines(raw: string): PeekLine[] {
	let entry: any;
	try {
		entry = JSON.parse(raw);
	} catch {
		return [];
	}
	const msg = entry?.message;
	if (!msg) return [];
	const out: PeekLine[] = [];
	const isResult = msg.role === "toolResult";
	for (const block of Array.isArray(msg.content) ? msg.content : []) {
		if (block.type === "toolCall") {
			const arg = callSummary(block.arguments);
			out.push({ gutter: "→", kind: "call", text: `${block.name}${arg ? ` ${shortenPath(clip(arg, 110))}` : ""}` });
		} else if (block.type === "text") {
			const text = stripThinking(block.text ?? "");
			if (!text) continue; // a turn that was pure reasoning has nothing to show
			if (isResult) {
				const kind = msg.isError ? "error" : "result";
				const name = msg.toolName ? `${msg.toolName}: ` : "";
				out.push({ gutter: msg.isError ? "✗" : "←", kind, text: `${name}${shortenPath(clip(text, 150))}` });
			} else {
				out.push({ gutter: "·", kind: "say", text: clip(text, 150) });
			}
		}
	}
	return out;
}

function tailLines(path: string, max: number): PeekLine[] {
	let text: string;
	try {
		text = readTail(path);
	} catch {
		return [{ gutter: "·", kind: "say", text: "(session file not readable yet)" }];
	}
	const lines: PeekLine[] = [];
	// First line of a mid-file read is usually a fragment — drop it.
	for (const raw of text.split("\n").slice(1)) lines.push(...eventLines(raw));
	return lines.slice(-max);
}

/** Gutter colour carries the line's role, so the eye can skip to failures without
 *  reading: → call, ← result, ✗ error, · the child speaking. */
function renderLine(line: PeekLine, theme: Theme): string {
	if (line.kind === "error") return `${theme.fg("error", line.gutter)} ${theme.fg("error", line.text)}`;
	if (line.kind === "call") {
		const space = line.text.indexOf(" ");
		const name = space === -1 ? line.text : line.text.slice(0, space);
		const arg = space === -1 ? "" : line.text.slice(space + 1);
		return `${theme.fg("accent", line.gutter)} ${theme.fg("toolTitle", name)}${arg ? ` ${theme.fg("muted", arg)}` : ""}`;
	}
	if (line.kind === "result") return `${theme.fg("dim", line.gutter)} ${theme.fg("dim", line.text)}`;
	return `${theme.fg("dim", line.gutter)} ${line.text}`;
}

/** Status as a coloured word, the way pi marks tool state. */
function statusTag(status: string, theme: Theme): string {
	if (status === "failed") return theme.fg("error", status);
	if (status === "completed") return theme.fg("success", status);
	if (status === "aborted") return theme.fg("warning", status);
	return theme.fg("muted", status);
}

export interface PeekPane {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
}

/**
 * Build the peek component. `getTasks` is polled live, so the pane keeps
 * updating while agents run.
 */
export function createPeekPane(
	getTasks: () => PeekTask[],
	theme: Theme,
	requestRender: () => void,
	close: () => void,
	abort: (task: PeekTask) => void,
): PeekPane {
	let selected = 0;
	let tailing = false;
	let confirming = false;
	const timer = setInterval(requestRender, POLL_MS);

	const clamp = (n: number, len: number) => (len === 0 ? 0 : Math.max(0, Math.min(len - 1, n)));

	/**
	 * Every row is padded to the full pane width and background-filled, so the
	 * transcript underneath never shows through the overlay.
	 */
	const row = (content: string, width: number): string => {
		const inner = width - 4; // 2 cols padding each side
		const text = truncateToWidth(content, Math.max(0, inner), "…");
		const pad = Math.max(0, inner - visibleWidth(text));
		return theme.bg("selectedBg", `  ${text}${" ".repeat(pad)}  `);
	};

	return {
		render(width: number): string[] {
			const tasks = getTasks();
			selected = clamp(selected, tasks.length);
			if (tasks.length === 0) return [row(theme.fg("dim", "No subagents in this session."), width)];
			const task = tasks[selected]!;
			const hint = confirming
				? theme.fg("error", `abort ${task.agent}?  y / n`)
				: theme.fg("dim", tailing ? "esc back · x abort" : "shift+↑↓ / jk move · enter tail · x abort · esc close");
			// Breadcrumb, not a bare name: while tailing, WHERE you are is the thing you
			// lose track of first, and the child's status belongs next to its name.
			const crumb = tailing
				? `${theme.fg("muted", "Subagents")}${theme.fg("dim", " › ")}${theme.fg("accent", theme.bold(task.agent))} ${statusTag(task.status, theme)}`
				: theme.fg("accent", theme.bold("Subagents"));
			const title = `${crumb} ${theme.fg("muted", `${selected + 1}/${tasks.length}`)}`;
			const rule = theme.fg("borderMuted", "─".repeat(Math.max(0, width - 4)));
			const lines = [row("", width), row(title, width), row(hint, width), row(rule, width)];

			if (!tailing) {
				for (const [i, t] of tasks.entries()) {
					const marker = i === selected ? theme.fg("accent", "❯ ") : "  ";
					lines.push(row(`${marker}${t.line}`, width));
				}
			} else if (!task.sessionFile) {
				lines.push(row(theme.fg("dim", "(no session file — agent has not started yet)"), width));
			} else {
				// ponytail: re-reads the tail each render (700ms poll). A watcher only pays off for files far bigger than a child session.
				const tail = tailLines(task.sessionFile, TAIL_ROWS);
				if (tail.length === 0) lines.push(row(theme.fg("dim", "(no activity yet)"), width));
				for (const line of tail) lines.push(row(renderLine(line, theme), width));
			}
			lines.push(row("", width));
			return lines;
		},
		handleInput(data: string): void {
			const tasks = getTasks();
			const len = tasks.length;
			if (confirming) {
				// Abort is irreversible, so it always costs a second keystroke.
				confirming = false;
				if (data === "y" || data === "Y") {
					const task = tasks[selected];
					if (task) abort(task);
				}
				requestRender();
				return;
			}
			if (data === "x" || data === "X") {
				if (tasks[selected]?.running) confirming = true;
			} else if (matchesKey(data, Key.escape)) {
				if (tailing) tailing = false;
				else close();
			} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
				tailing = true;
			} else if (matchesKey(data, Key.left)) {
				tailing = false;
			} else if (matchesKey(data, "shift+up") || matchesKey(data, Key.up) || data === "k") {
				// shift+↑↓ and j/k are the reliable pair: bare arrows can be eaten by prompt history.
				selected = clamp(selected - 1, len);
			} else if (matchesKey(data, "shift+down") || matchesKey(data, Key.down) || data === "j") {
				selected = clamp(selected + 1, len);
			}
			requestRender();
		},
		invalidate(): void {
			/* no cached strings */
		},
		dispose(): void {
			clearInterval(timer);
		},
	};
}
