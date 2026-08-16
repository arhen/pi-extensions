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

export function sid(ctx: { sessionManager?: { getSessionId?(): string } }): string {
	try {
		return ctx.sessionManager?.getSessionId?.() ?? "";
	} catch {
		return "";
	}
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
			if (!v || !Array.isArray(v.tasks) || typeof v.nextId !== "number") continue;
			if (sessions.has(k)) continue; // L4: never clobber a live in-memory session
			const maxId = v.tasks.reduce((m, t) => Math.max(m, t.id ?? 0), 0);
			if (v.nextId <= maxId) v.nextId = maxId + 1; // never reuse ids
			sessions.set(k, v);
		}
	} catch {
		/* first run or corrupt file — start empty */
	}
}

/** Debounced write of the whole map. Called on every commit; cheap at this cadence. */
/** Atomic write: tmp + rename so a crash mid-write can't corrupt the sidecar. */
function writeDisk(): void {
	try {
		const dir = path.dirname(stateFile());
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${stateFile()}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)));
		fs.renameSync(tmp, stateFile());
	} catch {
		/* persistence is best-effort */
	}
}

export function schedulePersist(): void {
	if (persistTimer) return;
	persistTimer = setTimeout(() => {
		persistTimer = undefined;
		writeDisk();
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
	// Flush the session's final state BEFORE deleting it — a pending debounce
	// would otherwise serialize the map without it and lose the data.
	if (persistTimer) {
		clearTimeout(persistTimer);
		persistTimer = undefined;
		writeDisk();
	}
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
	if (!sessions.has(sessionId)) loadFromDisk(); // any missing session reloads from disk
	if (!sessions.has(sessionId)) return false;
	return true;
}

/** Does the session have a live state slot? (widget reclaim check) */
export function hasSession(sessionId: string): boolean {
	return sessions.has(sessionId);
}

/** Test hook. */
export function __resetState(): void {
	sessions.clear();
	activeRenderSession = "";
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = undefined;
}
