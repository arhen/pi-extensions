import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { applyPreferences, loadPreferences, type ModelPreferences } from "./modelconfig.ts";
import type { ModelCatalog, ModelPricing, SelectableModel } from "./types.ts";

/**
 * Resolve a task's `model` reference against the registry. An absent reference inherits the
 * session model — delegation stays usable without naming one; naming one is a pin, not a
 * requirement.
 */
export function resolveChildModel(ctx: ExtensionContext, explicit: string | undefined) {
	if (!explicit?.trim()) return ctx.model;
	const ref = explicit.trim();
	if (!ctx.modelRegistry) return ctx.model;
	const available = ctx.modelRegistry.getAvailable();
	const sessionProvider = ctx.model?.provider;
	if (sessionProvider && !ref.includes("/")) {
		const own = available.filter((m) => m.provider === sessionProvider);
		const hit = own.find((m) => m.id === ref) ?? own.find((m) => m.id.endsWith(`/${ref}`));
		if (hit) return hit;
	}

	const byId = available.find((m) => m.id === ref);
	if (byId) return byId;
	for (let slash = ref.indexOf("/"); slash > 0; slash = ref.indexOf("/", slash + 1)) {
		const model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
		if (model) return model;
	}
	throw new Error(`Model not found: ${ref}`);
}

export interface ModelChoice {
	/** The reference to resolve, or undefined when the caller named none (inherit the session model). */
	requested: string | undefined;
	/** Set when an agent file supplied the model, so errors can say where it came from. */
	sourceFile?: string;
}

/**
 * Single owner of the model-precedence rule: a matched agent file's `model` wins over the inline
 * one. Spawn, pre-creation validation, and resume all resolve through this, so they cannot disagree
 * about which model a task actually uses.
 */
export function chooseModel(
	file: { model?: string; path?: string } | undefined,
	inline: string | undefined,
): ModelChoice {
	const fromFile = file?.model?.trim();
	return fromFile ? { requested: fromFile, sourceFile: file?.path } : { requested: inline };
}

/**
 * The thinking levels a model honors at runtime, from pi's own resolver, so the catalog cannot
 * promise a level the runtime would silently clamp: `xhigh`/`max` count only when explicitly
 * mapped. "off" is always accepted here (`validateThinking` returns early on it), so it is never
 * omitted even when the model maps it to null.
 */
export function supportedThinkingLevels(model: Model<Api> | undefined): ModelThinkingLevel[] {
	if (!model) return [];
	const levels = [...getSupportedThinkingLevels(model)];
	return levels.includes("off") ? levels : ["off", ...levels];
}

/** Keep only finite, non-negative per-Mtok rates; a partial or absent cost is unavailable, not free. */
export function normalizeCost(cost: unknown): ModelPricing | undefined {
	if (!cost || typeof cost !== "object") return undefined;
	const raw = cost as Partial<Record<keyof ModelPricing, unknown>>;
	const rate = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	const input = rate(raw.input);
	const output = rate(raw.output);
	if (input === undefined || output === undefined) return undefined;
	return { input, output, cacheRead: rate(raw.cacheRead) ?? 0, cacheWrite: rate(raw.cacheWrite) ?? 0 };
}

/**
 * Models a subagent task may name, scoped the way pi scopes them.
 *
 * `ctx.scopedModels` is pi's own resolution of `enabledModels` and `--models` — the set
 * `/scoped-models` shows. When no scoping is configured pi reports an empty list, and only then
 * does this fall back to the full available catalogue; `scope` tells the caller which case applies.
 *
 * A reference is listed only when it resolves back to the model it describes. Resolution is not a
 * pure `provider/id` split (a model whose bare id contains a slash can shadow another provider's
 * `provider/id`), so building the string naively could advertise a reference that silently selects
 * a different model. Anything ambiguous is reported as such, and a registry fault is reported
 * separately because the caller's fix differs.
 */
export function listSelectableModels(ctx: ExtensionContext, preferences?: ModelPreferences): ModelCatalog {
	if (!ctx.modelRegistry) {
		return { models: [], scope: "all", unavailable: "this context exposes no model registry" };
	}
	const scoped = ctx.scopedModels ?? [];
	const scope: ModelCatalog["scope"] = scoped.length > 0 ? "session" : "all";

	let candidate: Model<Api>[];
	try {
		candidate = scoped.length > 0 ? scoped.map((entry) => entry.model) : (ctx.modelRegistry.getAvailable() ?? []);
	} catch (err) {
		return { models: [], scope, unavailable: err instanceof Error ? err.message : String(err) };
	}

	const seen = new Set<string>();
	const models: SelectableModel[] = [];
	const ambiguous: string[] = [];
	const unresolved: string[] = [];
	for (const model of candidate) {
		const reference = `${model.provider}/${model.id}`;
		if (seen.has(reference)) continue;
		seen.add(reference);

		let resolved: Model<Api> | undefined;
		let lookupError: string | undefined;
		try {
			resolved = resolveChildModel(ctx, reference);
		} catch (err) {
			lookupError = err instanceof Error ? err.message : String(err);
		}
		if (!resolved) {
			unresolved.push(lookupError ? `${reference} (${lookupError})` : reference);
			continue;
		}
		if (resolved.provider !== model.provider || resolved.id !== model.id) {
			ambiguous.push(reference);
			continue;
		}
		models.push({
			reference,
			provider: model.provider,
			id: model.id,
			name: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
			reasoning: Boolean(model.reasoning),
			thinkingLevels: supportedThinkingLevels(model),
			contextWindow:
				typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0
					? model.contextWindow
					: 0,
			cost: normalizeCost((model as { cost?: unknown }).cost),
		});
	}

	// Preferences filter and order only. `preferences` is injectable so the file-to-catalog wiring
	// is testable without touching the user's real config.
	const prefs = preferences ?? loadPreferences(getAgentDir());
	const { entries: shown, unusedPatterns } = applyPreferences(models, prefs);
	const hiddenCount = models.length - shown.length;
	return {
		models: shown,
		scope,
		...(prefs.default ? { preferredDefault: prefs.default } : {}),
		...(prefs.error ? { configError: `${prefs.path}: ${prefs.error}` } : {}),
		...(hiddenCount > 0 ? { hidden: hiddenCount } : {}),
		...(unusedPatterns.length > 0 ? { unusedPatterns } : {}),
		...(ambiguous.length > 0
			? {
					ambiguous,
					reason: `another model's bare id would win resolution for ${ambiguous.join(", ")}`,
				}
			: {}),
		...(unresolved.length > 0
			? { unresolved, unresolvedReason: `the registry could not resolve these entries: ${unresolved.join(", ")}` }
			: {}),
		...(shown.length === 0
			? {
					unavailable:
						models.length > 0
							? `every listed model is hidden by ${prefs.path} — unhide one or remove \`hide\``
							: unresolved.length > 0
								? `the registry could not resolve any of its available models: ${unresolved.join("; ")}`
								: scope === "session"
									? "the session's enabled models could not be resolved"
									: "no model has usable credentials",
				}
			: {}),
	};
}
