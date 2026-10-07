import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Shared user config for the extension: exposure mode plus the auto-limit ceiling. One file, so a
 * write of one key must never drop the other — every writer merges through `writeSubagentConfig`.
 */
export const SUBAGENT_CONFIG_FILENAME = "subagents-config.json";

/**
 * Presentation preference for the subagent toolset, stored globally in `subagents-config.json`.
 * - auto: native codemode presentation when the codemode tool is active, direct otherwise.
 * - direct (default): legacy native declarations and active-tool script callability.
 * - codemode: subagent tools are callable from codemode scripts but not declared or listed.
 */
export type SubagentMode = "auto" | "direct" | "codemode";

export const DEFAULT_SUBAGENT_MODE: SubagentMode = "direct";

export function isSubagentMode(value: unknown): value is SubagentMode {
	return value === "auto" || value === "direct" || value === "codemode";
}

/** Resolved per call, so a test or `PI_CODING_AGENT_DIR` override applies to the running process. */
export function subagentConfigPath(): string {
	return join(getAgentDir(), SUBAGENT_CONFIG_FILENAME);
}

/**
 * Tolerant read: a missing, unreadable or non-object file degrades to an empty object, so a config
 * typo can neither break delegation nor hide the built-in defaults.
 */
export function readSubagentConfig(path = subagentConfigPath()): Record<string, unknown> {
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
		return raw as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** The stored exposure mode, or undefined when the file has no usable one. */
export function readStoredMode(path = subagentConfigPath()): SubagentMode | undefined {
	const mode = readSubagentConfig(path).mode;
	return isSubagentMode(mode) ? mode : undefined;
}

let writeQueue: Promise<unknown> = Promise.resolve();

/** Read-modify-write on a single queue, so concurrent writers of different keys cannot clobber each other. */
export function writeSubagentConfig(patch: Record<string, unknown>, path = subagentConfigPath()): Promise<void> {
	const write = writeQueue.then(async () => {
		await writeFile(path, `${JSON.stringify({ ...readSubagentConfig(path), ...patch }, null, 2)}\n`);
	});
	writeQueue = write.catch(() => {});
	return write;
}
