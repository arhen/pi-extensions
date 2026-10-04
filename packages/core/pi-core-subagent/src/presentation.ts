import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolExposure,
	ToolLoadout,
	ToolLoadoutChanges,
	ToolNamespace,
} from "@earendil-works/pi-coding-agent";

/**
 * Presentation preference for the subagent toolset.
 * - auto: native codemode presentation when the codemode tool is active, direct otherwise.
 * - direct: subagent tools are declared to the model (model-only exposure).
 * - codemode: subagent tools are callable from codemode scripts but not declared or listed.
 */
export type SubagentMode = "auto" | "direct" | "codemode";
export type EffectiveMode = "direct" | "codemode";

/** Branch-scoped custom entry holding the preference, so resume/tree keep it. */
export const MODE_ENTRY_TYPE = "subagent-mode";
export const CODEMODE_TOOL_NAME = "codemode";

export const SUBAGENT_NAMESPACE: ToolNamespace = {
	name: "subagents",
	description: "Isolated background subagents with a dependency-graph scheduler, git-worktree isolation and intercom.",
	instructions: `Isolated subagents with their own context, session and optional git worktree. Delegate independent review, testing, research or parallel analysis.

## Modes
- auto (default): codemode presentation while the \`codemode\` tool is active, direct otherwise.
- direct: subagent tools are declared to the model (model-only, not callable from scripts).
- codemode: tools are callable from scripts but not declared or listed; find them explicitly.
Switch with \`/subagents mode auto|direct|codemode\`. The preference is stored on the session branch and restored on reload, resume and tree navigation.

## Operations
- \`subagent({agent, task, prompt?, write?, tools?, model?, thinking?, cwd?, maxRuntimeMs?, autoAwait?, notifyPerTask?})\` runs one agent, or pass \`tasks: [...]\`, \`chain: [...]\` with \`{previous}\`, and \`needs\` edges that gate tasks and prepend upstream output.
- \`subagent_models()\` lists the models a task may name: the exact \`model\` value to pass, the thinking levels the runtime honors, the context window and pi catalog price per million tokens. The list follows this session's scoped models when scoping is configured, else every usable model; the output states which case applies, and references that would resolve to another model are called out as ambiguous.
- \`subagent_status(runId)\` returns live per-task status and session file paths; call once right after spawning.
- \`subagent_result(runId, taskId?)\` returns final text, usage and the worktree branch/diff summary.
- \`await_subagent(runId, timeoutMs?)\` blocks only when this turn must consume the result.
- \`reply_subagent(runId, taskId, message)\` answers a child \`ask_parent\` question and resumes it.
- \`steer_subagent(runId, taskId?, message)\` injects a message into running tasks.
- \`resume_subagent(runId, taskId, {message, model, thinking})\` revives a failed/aborted task with its context and branch.
- \`subagent_cancel(runId)\` aborts the run and kills its children.

## Rules
- Batch every sub-task in ONE call with \`tasks\`/\`needs\`; do not split parallel work into separate calls.
- \`model\` is optional: omit it to inherit the session model, or name one from \`subagent_models\` to pin the run; a matched agent file's \`model\` frontmatter wins over the inline value.
- Agents are read-only by default; \`write: true\` gives an isolated git worktree branch. Review the diff and merge with \`git merge --no-ff <branch>\`.
- A task that failed mid-work keeps its session file and branch: resume it, respawn only a task that never started.
- Completion and failures notify you: end the turn when you have no work left; use \`autoAwait\` only when the same turn must consume the result.
- Verify results independently; a subagent's claim of success is not evidence.

## Codemode
When codemode is active these tools are not declared. A script calls them as \`tools.subagent(...)\`, \`tools.subagent_status(...)\` and so on. Discover them with \`searchTools('subagent')\` or read this reference with \`describeNamespace('subagents')\`. Arguments are validated exactly like model-issued calls.`,
};

/** Adds the script-call path to the upfront rules, but only in the codemode profile. */
export const CODEMODE_DISCOVERY_GUIDELINE =
	"Codemode profile: subagent tools are not declared. Discover them with searchTools('subagent') or describeNamespace('subagents') and call them inside a script.";

/** The full-reference pointer only resolves while codemode scripts can reach `describeNamespace`. */
const NAMESPACE_REFERENCE = / Full reference: `describeNamespace\('subagents'\)`\./;

export function isSubagentMode(value: unknown): value is SubagentMode {
	return value === "auto" || value === "direct" || value === "codemode";
}

export type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface Presentation {
	readonly preference: SubagentMode;
	/** The profile currently registered, or undefined before the first registration. */
	readonly applied: EffectiveMode | undefined;
	/** Effective mode for the given active set, defaulting to the session's live active tools. */
	effective(active?: readonly string[]): EffectiveMode;
	/** Report preference, effective mode and codemode availability. */
	describe(): string;
	setPreference(mode: SubagentMode): void;
	/** Restore the latest preference stored on the session branch. */
	restore(ctx: ExtensionContext): void;
	/** Register the tools for the current effective mode; no-op when already applied. */
	sync(): boolean;
	/** Initial registration during extension load, before any session state exists. */
	registerInitial(): void;
}

/**
 * Owns the subagent exposure profile. Tools stay registered while only their exposure changes, so
 * the active selection (and the running manager) is preserved across mode switches.
 */
export function createPresentation(pi: ExtensionAPI, definitions: readonly AnyToolDefinition[]): Presentation {
	let preference: SubagentMode = "auto";
	let applied: EffectiveMode | undefined;

	const codemodeActive = (active: readonly string[]): boolean => active.includes(CODEMODE_TOOL_NAME);
	const effectiveFrom = (active: readonly string[]): EffectiveMode =>
		preference !== "direct" && codemodeActive(active) ? "codemode" : "direct";

	// Hides only the declarations of active subagent tools; other tools keep their loadout.
	const hideDeclarations = (loadout: ToolLoadout): ToolLoadoutChanges | undefined => {
		const active = new Set(loadout.declared.map((tool) => tool.name));
		if (effectiveFrom([...active]) !== "codemode") return undefined;
		const hidden = definitions.map((definition) => definition.name).filter((name) => active.has(name));
		return hidden.length > 0 ? { hiddenDeclarations: hidden } : undefined;
	};

	const register = (mode: EffectiveMode): void => {
		const exposure: ToolExposure = mode === "codemode" ? "deferred" : "model-only";
		for (const definition of definitions) {
			const promptGuidelines = [...(definition.promptGuidelines ?? [])];
			if (mode === "codemode" && !promptGuidelines.includes(CODEMODE_DISCOVERY_GUIDELINE))
				promptGuidelines.push(CODEMODE_DISCOVERY_GUIDELINE);
			// In the direct profile there is no script path, so the pointer would be unreachable.
			const description =
				mode === "direct" ? definition.description.replace(NAMESPACE_REFERENCE, "") : definition.description;
			pi.registerTool({
				...definition,
				description,
				exposure,
				namespace: SUBAGENT_NAMESPACE,
				promptGuidelines,
				prepareLoadout: hideDeclarations,
			} as AnyToolDefinition);
		}
		applied = mode;
	};

	return {
		get preference() {
			return preference;
		},
		get applied() {
			return applied;
		},
		effective: (active = pi.getActiveTools()) => effectiveFrom(active),
		describe() {
			const active = pi.getActiveTools();
			const target = effectiveFrom(active);
			const shown = applied ?? target;
			const available = codemodeActive(active);
			const availability = available ? "codemode is active" : "codemode is not active";
			const fallback = !available && preference === "codemode" ? "; using direct fallback" : "";
			const pending = target !== shown ? `; pending ${target} at the next request boundary` : "";
			return `Subagent exposure: mode ${preference} → effective ${shown} (${availability}${fallback}${pending}). Use /subagents mode auto|direct|codemode.`;
		},
		setPreference(mode) {
			preference = mode;
			pi.appendEntry(MODE_ENTRY_TYPE, { mode });
		},
		restore(ctx) {
			let restored: SubagentMode | undefined;
			for (const entry of ctx.sessionManager.getBranch()) {
				const candidate = entry as { type?: string; customType?: string; data?: { mode?: unknown } };
				if (
					candidate.type === "custom" &&
					candidate.customType === MODE_ENTRY_TYPE &&
					isSubagentMode(candidate.data?.mode)
				)
					restored = candidate.data.mode;
			}
			// Branch-sensitive state: a branch without an entry uses the package default again.
			preference = restored ?? "auto";
		},
		sync() {
			const next = effectiveFrom(pi.getActiveTools());
			if (next === applied) return false;
			register(next);
			return true;
		},
		registerInitial() {
			register("direct");
		},
	};
}
