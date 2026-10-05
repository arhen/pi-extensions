import { createHash } from "node:crypto";
import type { TaskSnapshot } from "./types.ts";

export function textFingerprint(text: string): string {
	return createHash("sha256").update(text.trim()).digest("hex");
}

export function matchesFinalText(task: TaskSnapshot, text: string): boolean {
	return textFingerprint(text) === (task.finalTextFingerprint ?? textFingerprint(task.finalText ?? ""));
}

export function artifactFingerprint(task: TaskSnapshot): string | undefined {
	if (!task.changedFiles?.length && !task.diffStat?.trim() && !task.worktreeError) return undefined;
	return textFingerprint(
		JSON.stringify([task.branch, [...(task.changedFiles ?? [])].sort(), task.diffStat, task.worktreeError]),
	);
}

export function outcomeFingerprint(task: TaskSnapshot): string {
	return textFingerprint(
		JSON.stringify([
			task.startedAt,
			task.status,
			task.toolCalls,
			task.finalTextFingerprint ?? textFingerprint(task.finalText ?? ""),
			task.error,
			artifactFingerprint(task),
		]),
	);
}
