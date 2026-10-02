import {
	BUILD_TOOLS,
	DEFAULT_MODE_NAME,
	MANAGED_TOOLS,
	type Mode,
	type ModeFileEntry,
	type ModeTools,
	READ_ONLY_TOOLS,
	TOOL_PRESETS,
	type ToolPreset,
	WRITE_TOOLS,
} from "./types.ts";

export function isToolPreset(value: unknown): value is ToolPreset {
	return typeof value === "string" && (TOOL_PRESETS as readonly string[]).includes(value);
}

export function isDefaultModeName(name: string): boolean {
	return name.trim() === DEFAULT_MODE_NAME;
}

export function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

export function normalizeTools(value: unknown): ModeTools {
	if (isToolPreset(value)) return value;
	if (Array.isArray(value)) {
		const names = value.filter((item): item is string => typeof item === "string");
		const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
		return unique.length > 0 ? unique : "default";
	}
	return "default";
}

export function normalizeModeEntry(rawName: string, raw: unknown): Mode | undefined {
	const name = rawName.trim();
	if (!name || isDefaultModeName(name)) return undefined;
	const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ModeFileEntry) : {};
	return {
		name,
		enabled: entry.enabled !== false,
		color: normalizeString(entry.color),
		description: normalizeString(entry.description),
		instructions: typeof entry.instructions === "string" && entry.instructions.trim() ? entry.instructions : undefined,
		tools: normalizeTools(entry.tools),
		model: normalizeString(entry.model),
		subagentModel: normalizeString(entry.subagentModel),
	};
}

/** Tool names a mode applies, intersected with the tools registered right now. */
export function resolveToolNames(tools: ModeTools, baseTools: string[], knownTools: readonly string[]): string[] {
	const known = new Set(knownTools);
	const unique = (names: readonly string[]) => [...new Set(names)].filter((name) => known.has(name));

	if (isToolPreset(tools)) {
		if (tools === "plan") {
			return unique([...baseTools.filter((name) => !WRITE_TOOLS.has(name)), ...READ_ONLY_TOOLS]);
		}
		if (tools === "build") {
			return unique([...BUILD_TOOLS, ...baseTools.filter((name) => !MANAGED_TOOLS.includes(name))]);
		}
		return unique(baseTools);
	}

	const explicit = unique(tools);
	return explicit.length > 0 ? explicit : unique(BUILD_TOOLS);
}

/** Cycle order: the built-in default first, then every enabled mode. */
export function cycleList(modes: readonly Mode[]): string[] {
	return [DEFAULT_MODE_NAME, ...modes.filter((mode) => mode.enabled).map((mode) => mode.name)];
}

export function nextInCycle(list: readonly string[], current: string | undefined, step: 1 | -1): string {
	if (list.length === 0) return DEFAULT_MODE_NAME;
	const index = list.indexOf(current ?? DEFAULT_MODE_NAME);
	if (index === -1) return (step === 1 ? list[0] : list.at(-1)) ?? DEFAULT_MODE_NAME;
	return list[(index + step + list.length) % list.length] ?? DEFAULT_MODE_NAME;
}

export function formatWorkingMessage(name: string): string {
	return `${name} is working...`;
}

export function formatStandby(name: string): string {
	return `${name} standby`;
}

export function describeTools(tools: ModeTools): string {
	return Array.isArray(tools) ? tools.join(", ") : tools;
}

export function parseToolList(text: string): string[] {
	return [
		...new Set(
			text
				.split(/[\s,]+/)
				.map((name) => name.trim())
				.filter(Boolean),
		),
	];
}

/**
 * Default the model of every subagent task that does not pin its own.
 * Returns true when the input was patched.
 */
export function applySubagentModel(input: Record<string, unknown>, model: string): boolean {
	let changed = false;

	for (const key of ["tasks", "chain"]) {
		const list = input[key];
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const task = item as Record<string, unknown>;
			const current = task.model;
			if (typeof current !== "string" || !current.trim()) {
				task.model = model;
				changed = true;
			}
		}
	}

	const single = input.model;
	if (typeof input.task === "string" && input.task.trim() && (typeof single !== "string" || !single.trim())) {
		input.model = model;
		changed = true;
	}

	return changed;
}
