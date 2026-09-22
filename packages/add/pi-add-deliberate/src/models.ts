import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export interface ScopedModelLike {
	model: Model<any>;
}

export function modelRef(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Model chooser source: session-scoped models when present, otherwise every
 * currently available (authenticated) model. Deduped and sorted by provider/id.
 */
export function selectableModels(scoped: readonly ScopedModelLike[], available: readonly Model<any>[]): Model<any>[] {
	const source = scoped.length > 0 ? scoped.map((entry) => entry.model) : [...available];
	const seen = new Set<string>();
	const models: Model<any>[] = [];
	for (const model of source) {
		const ref = modelRef(model);
		if (seen.has(ref)) continue;
		seen.add(ref);
		models.push(model);
	}
	return models.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

export function supportedThinkingLevels(model: Model<any>): ModelThinkingLevel[] {
	return getSupportedThinkingLevels(model);
}

export function resolveThinkingLevel(model: Model<any>, configured?: ModelThinkingLevel): ModelThinkingLevel {
	return clampThinkingLevel(model, configured ?? "off");
}

const INCONCLUSIVE_PREFLIGHT_PATTERN = /MissingSessionID|x-opencode-session/i;

/**
 * opencode-go rejects stateless `modelRegistry.complete` probes with
 * MissingSessionID even though real AgentSession requests carry the
 * x-opencode-session header, so a match proves nothing about the model.
 *
 * ponytail: provider-string exception with a fixed error pattern.
 * Ceiling: only `opencode-go` + this pattern; identical errors from other
 * providers and every other opencode-go failure stay fatal.
 * Upgrade path: remove when `modelRegistry.complete` can apply AgentSession
 * request transforms.
 */
export function isInconclusivePreflight(provider: string, message: string): boolean {
	return provider === "opencode-go" && INCONCLUSIVE_PREFLIGHT_PATTERN.test(message);
}
