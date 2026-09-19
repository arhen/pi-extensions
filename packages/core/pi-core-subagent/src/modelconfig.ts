import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Optional, user-owned model preferences for the subagent tools.
 *
 * Kept deliberately small: it filters and orders what `subagent_models` shows, and nothing else.
 * It never blocks a task — a model that is enabled in pi but hidden here still spawns, because pi
 * already owns what may run, and a second authority would contradict it.
 *
 * Read from `getAgentDir()/subagent-models.json`:
 *
 *   {
 *     "prefer":  ["openai-codex/*"],   // listed first, in this order; glob on "provider/id"
 *     "hide":    ["mlx-lm/*"],         // never listed
 *     "default": "openai-codex/gpt-5.6-luna"
 *   }
 *
 * A missing file, malformed JSON, or an unknown key are all non-fatal: the catalog simply falls
 * back to no preferences, because a config typo must not break delegation.
 */
export interface ModelPreferences {
	/** Patterns to sort first, in declaration order. */
	prefer: string[];
	/** Patterns to omit from the catalog. */
	hide: string[];
	/** Suggested model, surfaced to the caller but never applied as a substitute. */
	default?: string;
	/** Set when the file existed but could not be used, so the failure is reportable, not silent. */
	error?: string;
	/** The path that was read, or would be. */
	path: string;
}

export const MODEL_CONFIG_FILENAME = "subagent-models.json";

export const NO_PREFERENCES = (path: string): ModelPreferences => ({ prefer: [], hide: [], path });

/**
 * Match a model reference against a config pattern.
 *
 * `provider/id` is matched as a whole, and a bare `provider` also matches every model from that
 * provider, so `"openai-codex"` is shorthand for `"openai-codex/*"`. `*` matches any run of
 * characters. Matching is case-insensitive because model ids are written inconsistently by hand.
 */
export function matchesPattern(reference: string, pattern: string): boolean {
	const ref = reference.toLowerCase();
	const pat = pattern.trim().toLowerCase();
	if (!pat) return false;
	if (!pat.includes("*")) {
		// A bare provider name means "everything from this provider".
		return ref === pat || ref.startsWith(`${pat}/`);
	}
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

/** Parse config text. Exported so the rules are testable without touching the filesystem. */
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
	return {
		prefer,
		hide,
		...(fallback ? { default: fallback } : {}),
		...(errors.length > 0 ? { error: errors.join("; ") } : {}),
		path,
	};
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

/** Hide first, then order: preferred matches by declaration order, the rest after, stable. */
/**
 * Hide first, then order: preferred matches by declaration order, the rest after, stable.
 *
 * Also reports patterns that matched nothing. A `hide` entry for a model that is not enabled is
 * inert, and silence there reads as "it worked" when the config is in fact doing nothing.
 */
export function applyPreferences<T extends { reference: string }>(
	entries: T[],
	prefs: ModelPreferences,
): { entries: T[]; unusedPatterns: string[] } {
	const used = new Set<string>();
	const kept = entries.filter((e) => {
		const hit = prefs.hide.find((p) => matchesPattern(e.reference, p));
		if (hit) used.add(hit);
		return !hit;
	});
	const unusedPatterns = prefs.hide.filter((p) => !used.has(p));
	if (prefs.prefer.length === 0) return { entries: kept, unusedPatterns };
	const ranked = kept.map((entry, index) => {
		const pattern = prefs.prefer.find((p) => matchesPattern(entry.reference, p));
		if (pattern) used.add(pattern);
		return { entry, index, rank: pattern ? prefs.prefer.indexOf(pattern) : Number.MAX_SAFE_INTEGER };
	});
	// A `prefer` pattern that matches nothing is inert for the same reason a `hide` one is.
	for (const p of prefs.prefer) if (!used.has(p)) unusedPatterns.push(p);
	ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
	return { entries: ranked.map((r) => r.entry), unusedPatterns };
}
