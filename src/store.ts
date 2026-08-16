/**
 * Per-session store + sidecar persistence. One Map keyed by session id
 * (detached/child sessions never clobber each other). Persisted to a single
 * JSON sidecar in the agent dir — replaces rpiv-todo's branch replay; survives
 * restarts, does not replay history across forks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type TaskState, EMPTY_STATE } from "./types.ts";

const sessions = new Map<string, TaskState>();
let activeRenderSession = "";
let persistTimer: ReturnType<typeof setTimeout> | undefined;

export function sid(ctx: { sessionManager: { getSessionId(): string } }): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

function freshState(): TaskState {
	return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

function stateFile(): string {
	return path.join(getAgentDir(), "pi-todo-state.json");
}

function loadFromDisk(): void {
	try {
		const raw = JSON.parse(fs.readFileSync(stateFile(), "utf-8")) as Record<string, TaskState>;
		for (const [k, v] of Object.entries(raw)) {
			if (v && Array.isArray(v.tasks) && typeof v.nextId === "number") sessions.set(k, v);
		}
	} catch {
		/* first run or corrupt file — start empty */
	}
}

/** Debounced write of the whole map. Called on every commit; cheap at this cadence. */
export function schedulePersist(): void {
	if (persistTimer) return;
	persistTimer = setTimeout(() => {
		persistTimer = undefined;
		try {
			const dir = path.dirname(stateFile());
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(stateFile(), JSON.stringify(Object.fromEntries(sessions)));
		} catch {
			/* persistence is best-effort */
		}
	}, 500);
}

export function getState(sessionId: string): TaskState {
	return sessions.get(sessionId) ?? freshState();
}

export function commitState(sessionId: string, state: TaskState): void {
	sessions.set(sessionId, state);
	schedulePersist();
}

export function replaceState(sessionId: string, state: TaskState): void {
	sessions.set(sessionId, state);
}

export function evictSession(sessionId: string): void {
	sessions.delete(sessionId);
	schedulePersist();
}

export function setActiveRenderSession(id: string): void {
	activeRenderSession = id;
}
export function clearActiveRenderSession(): void {
	activeRenderSession = "";
}
export function getActiveRenderSession(): string {
	return activeRenderSession;
}

/** Ctx-less render pointer: the foreground session's state, or empty. */
export function getRenderState(): TaskState {
	return getState(activeRenderSession);
}

/** Restore the given session's slot from disk. Returns true when restored. */
export function restoreSession(sessionId: string): boolean {
	if (sessions.size === 0) loadFromDisk();
	if (!sessions.has(sessionId)) return false;
	return true;
}

/** Test hook. */
export function __resetState(): void {
	sessions.clear();
	activeRenderSession = "";
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = undefined;
}
