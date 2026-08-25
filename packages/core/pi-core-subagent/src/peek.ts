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

/** The whole readable tail, unsliced — the viewport decides what is shown. */
function tailLines(path: string): PeekLine[] {
	let text: string;
	try {
		text = readTail(path);
	} catch {
		return [{ gutter: "·", kind: "say", text: "(session file not readable yet)" }];
	}
	const lines: PeekLine[] = [];
	// First line of a mid-file read is usually a fragment — drop it.
	for (const raw of text.split("\n").slice(1)) lines.push(...eventLines(raw));
	return lines;
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
	/** Rows scrolled back from the newest line. 0 = pinned to live output.
	 *  A tail that keeps jumping to the bottom while you read is unusable, so any
	 *  scroll detaches from live and the 700ms poll stops moving the view. */
	let scrollback = 0;
	/** Content rows the last render could show — page keys need the real viewport,
	 *  which only render() knows (it is given the width and derives the height). */
	let viewport = TAIL_ROWS;
	/** Tail length at the previous render, to keep a scrolled-back view pinned to
	 *  the SAME lines as the child appends new ones. Without this the window is
	 *  anchored to the end of a growing list, so the text you are reading crawls
	 *  upward every poll. */
	let lastTotal = 0;
	const timer = setInterval(requestRender, POLL_MS);

	const clamp = (n: number, len: number) => (len === 0 ? 0 : Math.max(0, Math.min(len - 1, n)));
	/** Scrolling past either end is a no-op, never a wrap: the newest line is a
	 *  hard floor, the oldest readable line a hard ceiling. */
	const scrollBy = (rows: number) => {
		const task = getTasks()[selected];
		if (!tailing || !task?.sessionFile) return;
		const total = tailLines(task.sessionFile).length;
		// Anchor here as well as in render(): a scroll before the next render would
		// otherwise be read as "the file grew by its whole length" and jump the view.
		lastTotal = total;
		scrollback = Math.max(0, Math.min(Math.max(0, total - viewport), scrollback + rows));
	};

	/**
	 * Every row is a full-width bordered line: │ edge, one space of padding, the
	 * text padded out, then the closing edge. Background-filled so the transcript
	 * underneath never shows through the overlay, and edged so the pane reads as
	 * one object instead of a floating block of colour.
	 */
	const row = (content: string, width: number): string => {
		const inner = width - 4; // │ + space each side
		const text = truncateToWidth(content, Math.max(0, inner), "…");
		const pad = Math.max(0, inner - visibleWidth(text));
		const edge = theme.fg("border", "│");
		return theme.bg("selectedBg", `${edge} ${text}${" ".repeat(pad)} ${edge}`);
	};

	/** Top/bottom cap, and the ├───┤ divider between chrome and content. */
	const edgeRow = (width: number, left: string, right: string): string =>
		theme.bg("selectedBg", theme.fg("border", `${left}${"─".repeat(Math.max(0, width - 2))}${right}`));

	return {
		render(width: number): string[] {
			const tasks = getTasks();
			selected = clamp(selected, tasks.length);
			if (tasks.length === 0) {
				return [
					edgeRow(width, "╭", "╮"),
					row(theme.fg("dim", "No subagents in this session."), width),
					edgeRow(width, "╰", "╯"),
				];
			}
			const task = tasks[selected]!;
			const hint = confirming
				? theme.fg("error", `abort ${task.agent}?  y / n`)
				: theme.fg(
						"dim",
						tailing
							? "↑↓ / jk scroll · ⇧ page · g/G top·live · esc back · x abort"
							: "shift+↑↓ / jk move · enter tail · x abort · esc close",
					);
			// Breadcrumb, not a bare name: while tailing, WHERE you are is the thing you
			// lose track of first, and the child's status belongs next to its name.
			const crumb = tailing
				? `${theme.fg("muted", "Subagents")}${theme.fg("dim", " › ")}${theme.fg("accent", theme.bold(task.agent))} ${statusTag(task.status, theme)}`
				: theme.fg("accent", theme.bold("Subagents"));
			const title = `${crumb} ${theme.fg("muted", `${selected + 1}/${tasks.length}`)}`;
			const lines = [edgeRow(width, "╭", "╮"), row(title, width), row(hint, width), edgeRow(width, "├", "┤")];

			if (!tailing) {
				for (const [i, t] of tasks.entries()) {
					const marker = i === selected ? theme.fg("accent", "❯ ") : "  ";
					lines.push(row(`${marker}${t.line}`, width));
				}
			} else if (!task.sessionFile) {
				lines.push(row(theme.fg("dim", "(no session file — agent has not started yet)"), width));
			} else {
				// ponytail: re-reads the tail each render (700ms poll). A watcher only pays off for files far bigger than a child session.
				const tail = tailLines(task.sessionFile);
				viewport = TAIL_ROWS;
				if (scrollback > 0 && lastTotal > 0 && tail.length > lastTotal) scrollback += tail.length - lastTotal;
				lastTotal = tail.length;
				// Clamp here too: the readable tail is a sliding 64KB window, so old lines
				// fall off the front and a deep scrollback would render a blank window.
				scrollback = Math.max(0, Math.min(Math.max(0, tail.length - viewport), scrollback));
				const end = tail.length - scrollback;
				const window = tail.slice(Math.max(0, end - viewport), end);
				if (window.length === 0) lines.push(row(theme.fg("dim", "(no activity yet)"), width));
				for (const line of window) lines.push(row(renderLine(line, theme), width));
				// Scrolled-back views must say so: an unmoving tail is otherwise
				// indistinguishable from a stalled child.
				if (scrollback > 0) {
					lines.push(edgeRow(width, "├", "┤"));
					lines.push(row(theme.fg("warning", `↑ ${scrollback} older · G / end → live`), width));
				}
			}
			lines.push(edgeRow(width, "╰", "╯"));
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
				if (tailing) {
					tailing = false;
					scrollback = 0; // leaving the tail forgets where you were reading
				} else close();
			} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
				tailing = true;
				scrollback = 0; // a freshly opened tail always starts live
			} else if (matchesKey(data, Key.left)) {
				tailing = false;
				scrollback = 0;
			} else if (matchesKey(data, Key.pageUp)) {
				scrollBy(viewport);
			} else if (matchesKey(data, Key.pageDown)) {
				scrollBy(-viewport);
			} else if (data === "g") {
				scrollBy(Number.MAX_SAFE_INTEGER); // oldest readable line
			} else if (data === "G" || matchesKey(data, Key.end)) {
				scrollback = 0; // back to live
			} else if (matchesKey(data, "shift+up") || matchesKey(data, Key.up) || data === "k") {
				// In the tail the same keys scroll; in the list they move between agents.
				// shift+↑↓ and j/k are the reliable pair: bare arrows can be eaten by prompt history.
				if (tailing) scrollBy(1);
				else selected = clamp(selected - 1, len);
			} else if (matchesKey(data, "shift+down") || matchesKey(data, Key.down) || data === "j") {
				if (tailing) scrollBy(-1);
				else selected = clamp(selected + 1, len);
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
