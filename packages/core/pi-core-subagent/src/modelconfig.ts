import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Optional user preferences for `subagent_models`. This filters and orders what the tool shows and
 * nothing else: it never grants or blocks a model, because pi already owns what may run. A missing
 * file, malformed JSON, or an unknown key degrades to no preferences, so a config typo cannot break
 * delegation.
 */
export interface ModelPreferences {
	/** Patterns to sort first, in declaration order. */
	prefer: string[];
	/** Patterns to omit from the listing. */
	hide: string[];
	/** Suggested model, surfaced but never applied as a substitute. */
	default?: string;
	/** Set when the file existed but could not be used, so the failure is reportable, not silent. */
	error?: string;
	/** The path that was read, or would be. */
	path: string;
}

export const MODEL_CONFIG_FILENAME = "subagent-models.json";

export const NO_PREFERENCES = (path: string): ModelPreferences => ({ prefer: [], hide: [], path });

/**
 * Match a model reference against a config pattern. `provider/id` is matched as a whole; a bare
 * provider also matches everything from that provider, so `"openai-codex"` is shorthand for
 * `"openai-codex/*"`. `*` matches any run of characters, other metacharacters are literal, and
 * matching is case-insensitive.
 */
export function matchesPattern(reference: string, pattern: string): boolean {
	const ref = reference.toLowerCase();
	const pat = pattern.trim().toLowerCase();
	if (!pat) return false;
	if (!pat.includes("*")) return ref === pat || ref.startsWith(`${pat}/`);
	const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(ref);
}

function asStringArray(value: unknown, field: string, errors: string[]): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		errors.push(`${field} must be an array of strings`);
		return [];
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !item.trim()) errors.push(`${field} contains a non-string entry`);
		else out.push(item.trim());
	}
	return out;
}

/** Parse config text. Exported so the validation rules are testable without touching the filesystem. */
export function parsePreferences(text: string, path = MODEL_CONFIG_FILENAME): ModelPreferences {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return {
			prefer: [],
			hide: [],
			path,
			error: `not valid JSON (${err instanceof Error ? err.message : String(err)})`,
		};
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { prefer: [], hide: [], path, error: "must be a JSON object" };
	}
	const obj = raw as Record<string, unknown>;
	const errors: string[] = [];
	const known = new Set(["prefer", "hide", "default"]);
	const unknown = Object.keys(obj).filter((k) => !known.has(k));
	if (unknown.length > 0) errors.push(`unknown key(s): ${unknown.join(", ")}`);

	const prefer = asStringArray(obj.prefer, "prefer", errors);
	const hide = asStringArray(obj.hide, "hide", errors);
	let fallback: string | undefined;
	if (obj.default !== undefined) {
		if (typeof obj.default !== "string" || !obj.default.trim()) errors.push("default must be a non-empty string");
		else fallback = obj.default.trim();
	}
	if (errors.length > 0) return { prefer: [], hide: [], path, error: errors.join("; ") };
	return { prefer, hide, ...(fallback ? { default: fallback } : {}), path };
}

/** Read the preferences file if present. Never throws: an unusable file degrades to no preferences. */
export function loadPreferences(agentDir: string): ModelPreferences {
	const path = join(agentDir, MODEL_CONFIG_FILENAME);
	if (!existsSync(path)) return NO_PREFERENCES(path);
	try {
		return parsePreferences(readFileSync(path, "utf8"), path);
	} catch (err) {
		return {
			prefer: [],
			hide: [],
			path,
			error: `could not be read (${err instanceof Error ? err.message : String(err)})`,
		};
	}
}

/**
 * Hide first, then order: preferred matches by declaration order, the rest after, stable. Also
 * reports patterns that matched nothing — an inert `hide` entry must not read as though it worked.
 */
export function applyPreferences<T extends { reference: string }>(
	entries: T[],
	prefs: ModelPreferences,
): { entries: T[]; unusedPatterns: string[] } {
	if (prefs.error) return { entries: [...entries], unusedPatterns: [] };
	const used = new Set<string>();
	const kept = entries.filter((entry) => {
		const hit = prefs.hide.find((pattern) => matchesPattern(entry.reference, pattern));
		if (hit) used.add(hit);
		return !hit;
	});
	const unusedPatterns = prefs.hide.filter((pattern) => !used.has(pattern));
	if (prefs.prefer.length === 0) return { entries: kept, unusedPatterns };

	const ranked = kept.map((entry, index) => {
		const pattern = prefs.prefer.find((candidate) => matchesPattern(entry.reference, candidate));
		if (pattern) used.add(pattern);
		return { entry, index, rank: pattern ? prefs.prefer.indexOf(pattern) : Number.MAX_SAFE_INTEGER };
	});
	for (const pattern of prefs.prefer) if (!used.has(pattern)) unusedPatterns.push(pattern);
	ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
	return { entries: ranked.map((r) => r.entry), unusedPatterns };
}
