import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolExposure,
	ToolLoadout,
	ToolLoadoutChanges,
	ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_SUBAGENT_MODE,
	isSubagentMode,
	readStoredMode,
	type SubagentMode,
	writeSubagentConfig,
} from "./config.ts";

export { isSubagentMode, type SubagentMode } from "./config.ts";
export type EffectiveMode = "direct" | "codemode";

/** Branch-scoped custom entry holding the legacy preference; the global config file now wins. */
export const MODE_ENTRY_TYPE = "subagent-mode";
export const CODEMODE_TOOL_NAME = "codemode";

export const SUBAGENT_NAMESPACE: ToolNamespace = {
	name: "subagents",
	description: "Isolated background subagents with a dependency-graph scheduler, git-worktree isolation and intercom.",
	instructions: `Isolated subagents with their own context, session and optional git worktree. Delegate independent review, testing, research or parallel analysis.

## Modes
- direct (default): legacy native tool declarations and active-tool script callability; activating codemode alone does not switch profiles.
- auto (opt-in): codemode presentation while the \`codemode\` tool is active, direct otherwise.
- codemode: active tools are callable from scripts but not declared; inactive tools stay model-only and are not callable at all.
Switch with \`/subagents mode auto|direct|codemode\`. The preference is stored in the global \`subagents-config.json\` and applies to every session — reload, resume and tree navigation included.

## Operations
Object arguments, exactly as validated when issued by the model:
- \`subagent({ agent, task, prompt?, write?, tools?, model?, thinking?, cwd?, maxRuntimeMs?, autoAwait?, notifyPerTask? })\` runs one agent; \`tasks: [...]\`, \`chain: [...]\` with \`{previous}\` and \`needs\` edges gate tasks and prepend upstream output.
- \`subagent_models()\` lists the models a task may name: the exact \`model\` value to pass, the thinking levels the runtime honors, the context window and pi catalog price per million tokens. The list follows this session's scoped models when scoping is configured, else every usable model; the output states which case applies, and references that would resolve to another model are called out as ambiguous.
- \`subagent_status({ runId })\` returns live per-task status and session file paths; call once right after spawning.
- \`subagent_result({ runId, taskId? })\` returns final text, usage and the worktree branch/diff summary.
- \`await_subagent({ runId, timeoutMs? })\` blocks only when this turn must consume the result.
- \`reply_subagent({ runId, taskId, message })\` answers a child \`ask_parent\` question and resumes it.
- \`steer_subagent({ runId, taskId?, message })\` injects a message into running tasks.
- \`resume_subagent({ runId, taskId, message?, model?, thinking? })\` revives a failed/aborted task with its context and branch.
- \`subagent_cancel({ runId })\` aborts the run and kills its children.

## Agents
- Define each agent inline: invented name, focused system prompt. Agent files (\`.agents/agents\`, \`.claude/agents\`, \`.pi/agents\`; project dirs, then home) are matched by \`description\` against the goal, never by name. A match is authoritative: its body is the system prompt, its \`model\` frontmatter wins over the inline value, and its \`tools\` apply — only the per-call \`tools\` and \`write\` override them.
- Agents are read-only by default; \`write: true\` gives an isolated git worktree branch. Review the diff and merge with \`git merge --no-ff <branch>\`.
- \`model\` is optional: omit it to inherit the session model, or name one from \`subagent_models\` to pin the run.

## Rules
- Batch every sub-task in ONE call with \`tasks\`/\`needs\`; do not split parallel work into separate calls.
- After spawning, call \`subagent_status({ runId })\` once to confirm the tasks started; fix or respawn a task that died on spawn.
- A task that failed mid-work keeps its session file and branch: \`resume_subagent({ runId, taskId })\`, model swap included, revives it; respawn only a task that never started.
- Completion and failures notify you: end the turn when you have no work left; use \`autoAwait\` only when the same turn must consume the result.
- End each task with a runnable check, e.g. 'Verify: bun test'. A subagent's claim of success is not evidence.

## Codemode
When the codemode profile is explicitly selected (or selected by opt-in auto), these tools are not declared. Call an active operation as \`tools.<name>(args)\`; spawning uses \`await tools.subagent(args)\`. If its signature is unknown, inspect only \`text(await describeTool('subagent'))\` once and reuse it. For another operation, inspect only its exact name when needed. Broad search and tool-list dumps are unnecessary for these known names; this namespace is the optional full reference. Inactive tools remain unavailable. Arguments are validated exactly like model-issued calls.`,
};

/** Adds the script-call path to the upfront rules, but only in the codemode profile. */
export const CODEMODE_DISCOVERY_GUIDELINE =
	"Codemode subagents: call active tools as tools.<name>(args); spawn with await tools.subagent(args). If its signature is unknown, inspect only text(await describeTool('subagent')) once, then reuse it. Other helpers: describeTool(exactName) only when needed. No broad search or tool-list dump required; describeNamespace('subagents') is optional full reference.";

/** The full-reference pointer only resolves while codemode scripts can reach `describeNamespace`. */
const NAMESPACE_REFERENCE = / Full reference: `describeNamespace\('subagents'\)`\./;

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
	/** Restore the globally stored preference, with the session branch as the legacy fallback. */
	restore(ctx: ExtensionContext): void;
	/** Register the tools for the current effective mode; no-op when already applied. */
	sync(): boolean;
	/** Initial registration during extension load, before any session state exists. */
	registerInitial(): void;
}

/** Latest mode stored by an older package version on this session branch, if any. */
function branchPreference(ctx: ExtensionContext): SubagentMode | undefined {
	let restored: SubagentMode | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		const candidate = entry as { type?: string; customType?: string; data?: { mode?: unknown } };
		if (candidate.type === "custom" && candidate.customType === MODE_ENTRY_TYPE && isSubagentMode(candidate.data?.mode))
			restored = candidate.data.mode;
	}
	return restored;
}

/**
 * Owns the subagent exposure profile. Tools stay registered while only their exposure changes, so
 * the active selection (and the running manager) is preserved across mode switches.
 */
export function createPresentation(pi: ExtensionAPI, definitions: readonly AnyToolDefinition[]): Presentation {
	const ownNames = (): string[] => definitions.map((definition) => definition.name);
	let preference: SubagentMode = "direct";
	let applied: EffectiveMode | undefined;
	let appliedOwn = new Set<string>();

	const codemodeActive = (active: readonly string[]): boolean => active.includes(CODEMODE_TOOL_NAME);
	const effectiveFrom = (active: readonly string[]): EffectiveMode =>
		preference !== "direct" && codemodeActive(active) ? "codemode" : "direct";
	const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
		a.size === b.size && [...a].every((name) => b.has(name));

	// Hides only the declarations of active subagent tools; other tools keep their loadout. Runs on
	// every loadout recompute, so it follows the registered profile: a preference that is only
	// pending (mid-stream) must not rewrite a live loadout.
	const hideDeclarations = (loadout: ToolLoadout): ToolLoadoutChanges | undefined => {
		if (applied !== "codemode") return undefined;
		const active = new Set(loadout.declared.map((tool) => tool.name));
		const hidden = definitions.map((definition) => definition.name).filter((name) => active.has(name));
		return hidden.length > 0 ? { hiddenDeclarations: hidden } : undefined;
	};

	// Opted-in codemode defers only active own tools; inactive tools stay model-only. Legacy direct
	// callability follows native activation. Re-registering
	// must not reactivate a tool the user deactivated, so `defaultActive: false` replaces the native
	// default once the initial registration has made the tools available by default.
	const register = (mode: EffectiveMode, ownActive: ReadonlySet<string>, initial = false): void => {
		const own = new Set(ownNames());
		applied = mode;
		for (const definition of definitions) {
			const scriptCallable = mode === "codemode" && ownActive.has(definition.name);
			const exposure: ToolExposure = scriptCallable ? "deferred" : mode === "direct" ? "direct" : "model-only";
			const promptGuidelines = [...(definition.promptGuidelines ?? [])];
			if (scriptCallable && !promptGuidelines.includes(CODEMODE_DISCOVERY_GUIDELINE))
				promptGuidelines.push(CODEMODE_DISCOVERY_GUIDELINE);
			// Legacy direct tools stay ungrouped; the namespace reference only belongs to the opted-in profile.
			const description =
				mode === "direct" ? definition.description.replace(NAMESPACE_REFERENCE, "") : definition.description;
			pi.registerTool({
				...definition,
				description,
				exposure,
				namespace: mode === "codemode" ? SUBAGENT_NAMESPACE : undefined,
				promptGuidelines,
				prepareLoadout: hideDeclarations,
				...(initial ? {} : { defaultActive: false }),
			} as AnyToolDefinition);
		}
		// With an explicit --tools/defaultTools allowlist the SDK force-activates every registered
		// declarable tool it names, ignoring `defaultActive`. Restore exactly the own-name membership
		// that was asked for; every unrelated name, including a newly registered one, is preserved.
		if (!initial) {
			const active = pi.getActiveTools();
			if (active.some((name) => own.has(name) && !ownActive.has(name)))
				pi.setActiveTools(active.filter((name) => !own.has(name) || ownActive.has(name)));
		}
		appliedOwn = new Set(ownActive);
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
			return `Subagent exposure: mode ${preference} → effective ${shown} (${availability}${fallback}${pending}). Saved for all sessions. Use /subagents mode auto|direct|codemode.`;
		},
		setPreference(mode) {
			preference = mode;
			// The global config file is authoritative for every session; the branch entry stays as a
			// fallback for sessions that predate it and for readers of older package versions.
			void writeSubagentConfig({ mode }).catch(() => {});
			pi.appendEntry(MODE_ENTRY_TYPE, { mode });
		},
		restore(ctx) {
			// Global preference wins over the branch; the branch entry is the legacy fallback for
			// sessions that chose a mode before the preference moved into the config file.
			preference = readStoredMode() ?? branchPreference(ctx) ?? DEFAULT_SUBAGENT_MODE;
		},
		sync() {
			const own = new Set(ownNames());
			const active = pi.getActiveTools();
			const next = effectiveFrom(active);
			const ownActive = new Set(active.filter((name) => own.has(name)));
			// Members inside a profile are part of the registration: a helper activated or deactivated
			// natively must change its exposure (deferred vs model-only) at the next boundary.
			if (next === applied && sameSet(ownActive, appliedOwn)) return false;
			register(next, ownActive);
			return true;
		},
		registerInitial() {
			// Before the session runtime exists `pi.getActiveTools()` is not bound; the optimistic
			// all-active set is corrected by `sync()` once the session starts.
			register("direct", new Set(ownNames()), true);
		},
	};
}
