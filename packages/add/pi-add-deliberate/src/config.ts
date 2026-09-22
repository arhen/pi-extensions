import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const CONFIG_FILE_NAME = "deliberate.json";
export const DEFAULT_PLAN_PATH = "PLAN.md";

export type DeliberateMode = "advise" | "plan";

export interface DeliberateModelRef {
	provider: string;
	id: string;
}

export interface DeliberateModeConfig {
	model?: DeliberateModelRef;
	thinking?: ModelThinkingLevel;
	tools?: string[];
}

export interface DeliberatePlanConfig extends DeliberateModeConfig {
	path?: string;
}

export interface DeliberateConfig {
	advise?: DeliberateModeConfig;
	plan?: DeliberatePlanConfig;
}

export interface SavedPlanState {
	path: string;
	savedAt: string;
}

export interface LoadedConfig {
	config: DeliberateConfig | null;
	path: string;
	error?: string;
}

export const ADVISE_ALLOWED_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
export const PLAN_ALLOWED_TOOLS = ["read", "grep", "find", "ls"] as const;

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function configFilePath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

export function allowedTools(mode: DeliberateMode): readonly string[] {
	return mode === "advise" ? ADVISE_ALLOWED_TOOLS : PLAN_ALLOWED_TOOLS;
}

export function defaultTools(mode: DeliberateMode): string[] {
	return [...allowedTools(mode)];
}

/** Manually edited tools are restricted to the mode's read-only allowlist; never edit/write. */
export function filterTools(mode: DeliberateMode, tools?: readonly string[]): string[] {
	if (!tools) return defaultTools(mode);
	const allowed = new Set(allowedTools(mode));
	const filtered: string[] = [];
	for (const tool of tools) {
		if (allowed.has(tool) && !filtered.includes(tool)) filtered.push(tool);
	}
	return filtered.length > 0 ? filtered : defaultTools(mode);
}

/** Relative paths resolve from cwd; `~` and `~/...` resolve from home; absolute paths stay absolute. */
export function resolvePlanPath(rawPath: string | undefined, cwd: string, home = homedir()): string {
	const value = (rawPath ?? "").trim() || DEFAULT_PLAN_PATH;
	if (value === "~") return home;
	if (value.startsWith("~/")) return resolve(home, value.slice(2));
	return resolve(cwd, value);
}

export function validatePlanMarkdown(markdown: string): string | null {
	return markdown.trim().length > 0 ? null : "plan markdown is empty";
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		await writeFile(tempPath, content, "utf8");
		await rename(tempPath, path);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

type ParseResult<T> = { value: T } | { error: string };

function parseModelRef(raw: unknown): ParseResult<DeliberateModelRef> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "model must be an object" };
	const obj = raw as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		if (key !== "provider" && key !== "id") return { error: `unknown model key "${key}"` };
	}
	if (typeof obj.provider !== "string" || !obj.provider.trim())
		return { error: "model.provider must be a non-empty string" };
	if (typeof obj.id !== "string" || !obj.id.trim()) return { error: "model.id must be a non-empty string" };
	return { value: { provider: obj.provider.trim(), id: obj.id.trim() } };
}

function parseModeConfig(raw: unknown, mode: DeliberateMode): ParseResult<DeliberatePlanConfig> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${mode} must be an object` };
	const obj = raw as Record<string, unknown>;
	const allowedKeys =
		mode === "plan" ? new Set(["model", "thinking", "tools", "path"]) : new Set(["model", "thinking", "tools"]);
	for (const key of Object.keys(obj)) {
		if (!allowedKeys.has(key)) return { error: `${mode}: unknown key "${key}"` };
	}
	const value: DeliberatePlanConfig = {};
	if (obj.model !== undefined) {
		const parsed = parseModelRef(obj.model);
		if ("error" in parsed) return { error: `${mode}: ${parsed.error}` };
		value.model = parsed.value;
	}
	if (obj.thinking !== undefined) {
		if (typeof obj.thinking !== "string" || !THINKING_LEVELS.includes(obj.thinking as ModelThinkingLevel)) {
			return { error: `${mode}: thinking must be one of ${THINKING_LEVELS.join(", ")}` };
		}
		value.thinking = obj.thinking as ModelThinkingLevel;
	}
	if (obj.tools !== undefined) {
		if (!Array.isArray(obj.tools) || obj.tools.some((tool) => typeof tool !== "string" || !tool.trim())) {
			return { error: `${mode}: tools must be an array of non-empty strings` };
		}
		value.tools = obj.tools.map((tool) => (tool as string).trim());
	}
	if (mode === "plan" && obj.path !== undefined) {
		if (typeof obj.path !== "string" || !obj.path.trim()) return { error: "plan: path must be a non-empty string" };
		value.path = obj.path.trim();
	}
	return { value };
}

/** Strict validation: unknown keys, wrong types, or out-of-range values reject the whole config. */
export function parseConfig(raw: unknown): ParseResult<DeliberateConfig> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "config must be a JSON object" };
	const obj = raw as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		if (key !== "advise" && key !== "plan") return { error: `unknown key "${key}"` };
	}
	const config: DeliberateConfig = {};
	if (obj.advise !== undefined) {
		const parsed = parseModeConfig(obj.advise, "advise");
		if ("error" in parsed) return { error: parsed.error };
		config.advise = parsed.value;
	}
	if (obj.plan !== undefined) {
		const parsed = parseModeConfig(obj.plan, "plan");
		if ("error" in parsed) return { error: parsed.error };
		config.plan = parsed.value;
	}
	return { value: config };
}

export async function loadConfig(agentDir: string): Promise<LoadedConfig> {
	const path = configFilePath(agentDir);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined;
		if (code === "ENOENT") return { config: null, path };
		return { config: null, path, error: `could not read config: ${errorText(error)}` };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { config: null, path, error: "config is not valid JSON" };
	}
	const parsed = parseConfig(raw);
	if ("error" in parsed) return { config: null, path, error: parsed.error };
	return { config: parsed.value, path };
}

export async function saveConfig(agentDir: string, config: DeliberateConfig): Promise<string> {
	const path = configFilePath(agentDir);
	await atomicWriteFile(path, `${JSON.stringify(config, null, "\t")}\n`);
	return path;
}

export async function clearConfig(agentDir: string): Promise<void> {
	await rm(configFilePath(agentDir), { force: true });
}

/** Remove one mode; returns null when no mode remains (caller may delete the file). */
export function clearMode(config: DeliberateConfig | null, mode: DeliberateMode): DeliberateConfig | null {
	if (!config) return null;
	const next: DeliberateConfig = { ...config };
	delete next[mode];
	return next.advise || next.plan ? next : null;
}

/** Latest saved plan on the current branch, ignoring entries with malformed data. */
export function latestPlanEntry(
	branch: readonly { type?: string; customType?: string; data?: unknown }[],
): SavedPlanState | null {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== "deliberate-plan") continue;
		const data = entry.data as { path?: unknown; savedAt?: unknown } | undefined;
		if (typeof data?.path !== "string" || data.path.length === 0) continue;
		return { path: data.path, savedAt: typeof data.savedAt === "string" ? data.savedAt : "" };
	}
	return null;
}

export function planWidgetLines(plan: SavedPlanState): string[] {
	return [`📋 Plan: ${plan.path}`, "   /plan-view · Ctrl+Alt+P"];
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
