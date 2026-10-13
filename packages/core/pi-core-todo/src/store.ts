import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { EMPTY_STATE, type TaskState, TOOL_NAME } from "./types.ts";

export const STATE_TYPE = "pi-core-todo-state";

const sessions = new Map<string, TaskState>();
let activeRenderSession = "";

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

function normalizeState(value: unknown): TaskState | undefined {
	if (!value || typeof value !== "object") return;
	const state = value as TaskState;
	if (!Array.isArray(state.tasks) || !Number.isSafeInteger(state.nextId) || state.nextId < 1) return;
	for (const task of state.tasks) {
		if (
			!task ||
			!Number.isSafeInteger(task.id) ||
			task.id < 1 ||
			typeof task.subject !== "string" ||
			!["pending", "in_progress", "completed", "deleted"].includes(task.status)
		)
			return;
	}
	return {
		tasks: structuredClone(state.tasks),
		nextId: state.tasks.reduce((nextId, task) => Math.max(nextId, task.id + 1), state.nextId),
	};
}

function loadLegacyState(sessionId: string): TaskState | undefined {
	if (!sessionId) return;
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "pi-todo-state.json"), "utf-8"));
		return normalizeState(raw?.[sessionId]);
	} catch {
		return;
	}
}

export function getState(sessionId: string): TaskState {
	return sessions.get(sessionId) ?? freshState();
}

export function commitState(sessionId: string, state: TaskState): void {
	sessions.set(sessionId, state);
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

export function getRenderState(): TaskState {
	return getState(activeRenderSession);
}

export function restoreSession(sessionId: string, branch: readonly SessionEntry[], allowLegacy = true): boolean {
	let state: TaskState | undefined;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "custom" && entry.customType === STATE_TYPE) {
			state = normalizeState(entry.data);
		} else if (entry.type === "message") {
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== TOOL_NAME || message.isError) continue;
			const details = message.details as { action?: string; error?: unknown } | undefined;
			// Read/error results can contain empty snapshots from the old persistence bug.
			if (!details || details.error || !["create", "update", "batch", "delete", "clear"].includes(details.action ?? ""))
				continue;
			state = normalizeState(details);
		}
		if (state) break;
	}
	if (!state && allowLegacy) state = loadLegacyState(sessionId);
	sessions.set(sessionId, state ?? freshState());
	return state !== undefined;
}

export function hasSession(sessionId: string): boolean {
	return sessions.has(sessionId);
}
