import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Global widget preference, shared by every session: `persistCollapsed` opts into remembering the
 * collapse decision, `collapsed` is that decision. Both live in one file, so every writer merges
 * through `writeTodoConfig` instead of replacing the document.
 */
export const TODO_CONFIG_FILENAME = "todo-config.json";

export interface TodoConfig {
	/** Remember the collapsed/expanded decision across sessions. */
	persistCollapsed: boolean;
	/** The remembered decision; ignored while `persistCollapsed` is off. */
	collapsed: boolean;
}

export const DEFAULT_TODO_CONFIG: TodoConfig = { persistCollapsed: false, collapsed: false };

/** Resolved per call, so a test or `PI_CODING_AGENT_DIR` override applies to the running process. */
export function todoConfigPath(): string {
	return join(getAgentDir(), TODO_CONFIG_FILENAME);
}

function readRecord(path: string): Record<string, unknown> {
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
		return raw as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Tolerant read: a missing, unreadable or malformed file degrades to the defaults, never to an error. */
export function readTodoConfig(path = todoConfigPath()): TodoConfig {
	const raw = readRecord(path);
	return {
		persistCollapsed: raw.persistCollapsed === true,
		collapsed: raw.collapsed === true,
	};
}

let writeQueue: Promise<unknown> = Promise.resolve();

/** Read-modify-write on a single queue, so concurrent writers of different keys cannot clobber each other. */
export function writeTodoConfig(patch: Partial<TodoConfig>, path = todoConfigPath()): Promise<void> {
	const write = writeQueue.then(async () => {
		await writeFile(path, `${JSON.stringify({ ...readRecord(path), ...patch }, null, 2)}\n`);
	});
	writeQueue = write.catch(() => {});
	return write;
}

/** Resolves once every queued write has settled. Fire-and-forget callers use this to drain at shutdown. */
export function flushTodoConfigWrites(): Promise<void> {
	return writeQueue.then(() => {});
}
