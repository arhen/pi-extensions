import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeModeEntry } from "./logic.ts";
import type { Mode } from "./types.ts";

export type ModeOrigin = "global" | "project";

interface ModeRecord {
	mode: Mode;
	origin: ModeOrigin;
}

export function serializeMode(mode: Mode): Record<string, unknown> {
	const entry: Record<string, unknown> = { enabled: mode.enabled, tools: mode.tools };
	if (mode.color) entry.color = mode.color;
	if (mode.description) entry.description = mode.description;
	if (mode.instructions) entry.instructions = mode.instructions;
	if (mode.model) entry.model = mode.model;
	if (mode.subagentModel) entry.subagentModel = mode.subagentModel;
	return entry;
}

/**
 * Modes live in two JSON files, both shaped as `{ "<name>": { ... } }`:
 *   <agent-dir>/modes.json   global
 *   <cwd>/.pi/modes.json     project, overrides global entries by name
 * The reserved name "default" is never stored; it is the built-in vanilla mode.
 */
export class ModeStore {
	private readonly records = new Map<string, ModeRecord>();
	readonly globalPath: string;
	readonly projectPath: string;
	private hadProjectFile = false;

	constructor(cwd: string, options?: { globalPath?: string; projectPath?: string }) {
		this.globalPath = options?.globalPath ?? join(getAgentDir(), "modes.json");
		this.projectPath = options?.projectPath ?? join(cwd, CONFIG_DIR_NAME, "modes.json");
	}

	load(): void {
		this.records.clear();
		this.hadProjectFile = existsSync(this.projectPath);
		this.readFile(this.globalPath, "global");
		this.readFile(this.projectPath, "project");
	}

	private readFile(path: string, origin: ModeOrigin): void {
		if (!existsSync(path)) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
		for (const [rawName, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
			const mode = normalizeModeEntry(rawName, rawEntry);
			if (mode) this.records.set(mode.name, { mode, origin });
		}
	}

	list(): Mode[] {
		return [...this.records.values()].map((record) => record.mode).sort((a, b) => a.name.localeCompare(b.name));
	}

	names(): string[] {
		return this.list().map((mode) => mode.name);
	}

	get(name: string): Mode | undefined {
		return this.records.get(name)?.mode;
	}

	upsert(mode: Mode): void {
		const existing = this.records.get(mode.name);
		this.records.set(mode.name, { mode, origin: existing?.origin ?? "global" });
	}

	remove(name: string): void {
		this.records.delete(name);
	}

	rename(oldName: string, newName: string): void {
		const record = this.records.get(oldName);
		if (!record) return;
		this.records.delete(oldName);
		record.mode.name = newName;
		this.records.set(newName, record);
	}

	save(): void {
		this.writeFile(this.globalPath, "global");
		const hasProjectModes = [...this.records.values()].some((record) => record.origin === "project");
		if (this.hadProjectFile || hasProjectModes) this.writeFile(this.projectPath, "project");
	}

	private writeFile(path: string, origin: ModeOrigin): void {
		const out: Record<string, unknown> = {};
		for (const [name, record] of this.records) {
			if (record.origin === origin) out[name] = serializeMode(record.mode);
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
	}
}
