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

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** One session-file line → one display line: [gutter, text]. Irrelevant → null. */
function eventLine(raw: string): [string, string] | null {
	let entry: any;
	try {
		entry = JSON.parse(raw);
	} catch {
		return null;
	}
	const msg = entry?.message;
	if (!msg) return null;
	const out: [string, string][] = [];
	for (const block of msg.content ?? []) {
		if (block.type === "toolCall") {
			const arg = Object.values(block.arguments ?? {}).find((v) => typeof v === "string" && v.trim() !== "") as
				| string
				| undefined;
			out.push(["→", `${block.name}${arg ? ` ${clip(arg, 120)}` : ""}`]);
		} else if (block.type === "text" && block.text?.trim()) {
			out.push([msg.role === "toolResult" ? "←" : "·", clip(block.text, 160)]);
		}
	}
	return out[0] ?? null;
}

function tailLines(path: string, max: number): [string, string][] {
	let text: string;
	try {
		text = readTail(path);
	} catch {
		return [["·", "(session file not readable yet)"]];
	}
	const lines: [string, string][] = [];
	// First line of a mid-file read is usually a fragment — drop it.
	for (const raw of text.split("\n").slice(1)) {
		const line = eventLine(raw);
		if (line) lines.push(line);
	}
	return lines.slice(-max);
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
			const title = `${theme.fg("accent", theme.bold(tailing ? task.agent : "Subagents"))} ${theme.fg("muted", `${selected + 1}/${tasks.length}`)}`;
			const lines = [row("", width), row(title, width), row(hint, width), row("", width)];

			if (!tailing) {
				for (const [i, t] of tasks.entries()) {
					const marker = i === selected ? theme.fg("accent", "❯ ") : "  ";
					lines.push(row(`${marker}${t.line}`, width));
				}
			} else if (!task.sessionFile) {
				lines.push(row(theme.fg("dim", "(no session file — agent has not started yet)"), width));
			} else {
				// ponytail: re-reads the tail each render (700ms poll). A watcher only pays off for files far bigger than a child session.
				for (const [gutter, text] of tailLines(task.sessionFile, TAIL_ROWS)) {
					lines.push(row(`${theme.fg("dim", gutter)} ${gutter === "←" ? theme.fg("dim", text) : text}`, width));
				}
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
