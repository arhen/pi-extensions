import { clampThinkingLevel, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { colorize } from "./colors.ts";
import type { ModeEditor } from "./editor.ts";
import {
	applyResumeOverrides,
	applySubagentModel,
	applySubagentThinking,
	clampSubagentThinking,
	formatStandby,
	formatWorkingMessage,
	resolveToolNames,
} from "./logic.ts";
import type { ModeStore } from "./store.ts";
import {
	DEFAULT_MODE_NAME,
	type Mode,
	type ModeThinking,
	STATE_ENTRY_TYPE,
	WIDGET_KEY,
	WORKING_MESSAGE_EVENT,
} from "./types.ts";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface Snapshot {
	model: Model<any> | undefined;
	thinking: ThinkingLevel;
	tools: string[];
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface ActivateResult {
	ok: boolean;
	message?: string;
}

export interface PersistedSnapshot {
	model?: string | null;
	thinking: ThinkingLevel;
	tools: string[];
}

export interface PersistedState {
	name: string | null;
	snapshot?: PersistedSnapshot | null;
}

function splitModelRef(ref: string): [string, string] | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return [ref.slice(0, slash), ref.slice(slash + 1)];
}

const ADVISOR_MAX_RUNTIME_MS = 10 * 60_000;

const ADVISOR_PROMPT =
	"You are a read-only advisor giving a second opinion. Read and search the repo (read, grep, find, ls) to gather context, then answer the question concisely with a recommendation. Never edit, write, or run mutating commands. Never use ask_parent; if context is missing, say what is missing in your final answer instead of guessing.";

export interface AdvisorResult {
	text: string;
	model: string;
	thinking?: ModeThinking;
	via: "subagent" | "direct";
}

interface AdvisorTaskSnapshot {
	status?: string;
	finalText?: string;
	model?: string;
	provider?: string;
	modelNote?: string;
	agentFile?: string;
}

interface AdvisorOutcome {
	isError: boolean;
	result?: {
		content?: { type: string; text?: string }[];
		details?: { run?: { id?: string; tasks?: AdvisorTaskSnapshot[] } };
	};
}

/**
 * Accept only a genuinely completed advisor task. A failed run still returns `isError: false` with a
 * summary text, a failed preflight silently swaps in the leader model (`modelNote`), and a repo agent
 * file can take over the prompt and model (`agentFile`) — all three fall back to the one-shot call.
 */
function advisorTask(
	outcome: AdvisorOutcome,
	provider: string,
	modelId: string,
): { task: AdvisorTaskSnapshot } | { reason: string } {
	if (outcome.isError) return { reason: "subagent call failed" };
	const task = outcome.result?.details?.run?.tasks?.[0];
	if (task?.status !== "completed") return { reason: `advisor run ${task?.status ?? "unknown"}` };
	if (task.modelNote || task.model !== modelId || (task.provider !== undefined && task.provider !== provider))
		return { reason: "advisor model was substituted" };
	if (task.agentFile) return { reason: `agent file ${task.agentFile} took over the advisor` };
	return { task };
}

export class ModeEngine {
	private snapshot?: Snapshot;
	private current?: Mode;
	private store?: ModeStore;
	private editor?: { editor: ModeEditor; tui: TUI };

	constructor(private readonly pi: ExtensionAPI) {}

	setStore(store: ModeStore): void {
		this.store = store;
	}

	get activeName(): string | undefined {
		return this.current?.name;
	}

	get activeMode(): Mode | undefined {
		return this.current;
	}

	attachEditor(editor: ModeEditor, tui: TUI): void {
		this.editor = { editor, tui };
	}

	detachEditor(): void {
		this.editor = undefined;
	}

	/** Apply a mode, or the built-in default when `name` is undefined. */
	async activate(name: string | undefined, ctx: ExtensionContext): Promise<ActivateResult> {
		const wantsMode = Boolean(name) && name !== DEFAULT_MODE_NAME;
		const target = wantsMode ? this.store?.get(name as string) : undefined;
		if (wantsMode && !target) return { ok: false, message: `Unknown mode "${name}"` };

		if (!this.snapshot) {
			this.snapshot = { model: ctx.model, thinking: this.pi.getThinkingLevel(), tools: this.pi.getActiveTools() };
		}

		if (!target) {
			await this.restoreSnapshot();
			this.current = undefined;
			this.applyVisuals(ctx);
			return { ok: true };
		}

		const notes: string[] = [];
		if (target.model) {
			const ref = splitModelRef(target.model);
			const model = ref ? ctx.modelRegistry.find(ref[0], ref[1]) : undefined;
			if (!model) {
				notes.push(`model ${target.model} not found`);
			} else if (!(await this.pi.setModel(model))) {
				notes.push(`no credentials for ${target.model}`);
			}
		} else if (this.snapshot.model) {
			await this.pi.setModel(this.snapshot.model);
		}

		if (target.advisorModel) {
			const split = splitModelRef(target.advisorModel);
			const advisor = split ? ctx.modelRegistry.find(split[0], split[1]) : undefined;
			if (!advisor) {
				notes.push(`advisor model ${target.advisorModel} not found`);
			} else if (target.advisorThinking) {
				const clamped = clampThinkingLevel(advisor, target.advisorThinking as ModelThinkingLevel);
				if (clamped !== target.advisorThinking) {
					notes.push(
						`advisor thinking ${target.advisorThinking} unsupported on ${target.advisorModel}; runs at ${clamped}`,
					);
				}
			}
		}
		if (target.subagentModel && target.subagentThinking) {
			const split = splitModelRef(target.subagentModel);
			const sub = split ? ctx.modelRegistry.find(split[0], split[1]) : undefined;
			if (sub) {
				const clamped = clampThinkingLevel(sub, target.subagentThinking as ModelThinkingLevel);
				if (clamped !== target.subagentThinking) {
					notes.push(
						`subagent thinking ${target.subagentThinking} unsupported on ${target.subagentModel}; runs at ${clamped}`,
					);
				}
			}
		}

		const known = this.pi.getAllTools().map((tool) => tool.name);
		const resolved = resolveToolNames(target.tools, this.snapshot.tools, known);
		// The advisor tool activates only for modes that configure it; a mode that names it without an
		// advisor model would register a tool that can only error, so strip it.
		if (!target.advisorModel) {
			const index = resolved.indexOf("advisor");
			if (index >= 0) resolved.splice(index, 1);
		} else if (known.includes("advisor") && !resolved.includes("advisor")) {
			resolved.push("advisor");
		}
		this.pi.setActiveTools(resolved);
		this.pi.setThinkingLevel(target.thinking ?? this.snapshot.thinking);

		this.current = target;
		this.applyVisuals(ctx);
		return notes.length > 0 ? { ok: true, message: notes.join("; ") } : { ok: true };
	}

	/** Drop the mode and the pre-mode snapshot without touching model or tools. */
	reset(ctx: ExtensionContext): void {
		this.current = undefined;
		this.snapshot = undefined;
		this.applyVisuals(ctx);
	}

	/** Re-apply the current mode after its definition changed (no snapshot reset). */
	async reapply(ctx: ExtensionContext): Promise<void> {
		await this.activate(this.activeName, ctx);
	}

	async switchTo(name: string | undefined, ctx: ExtensionContext, options?: { persist?: boolean }): Promise<boolean> {
		const result = await this.activate(name, ctx);
		if (!result.ok) {
			ctx.ui.notify(result.message ?? "Mode switch failed", "error");
			return false;
		}
		if (options?.persist !== false) this.persistState();
		const label = this.activeName ? `Mode "${this.activeName}" active` : "Default mode active";
		ctx.ui.notify(result.message ? `${label} (${result.message})` : label, result.message ? "warning" : "info");
		return true;
	}

	persistState(): void {
		const snapshot: PersistedSnapshot | undefined = this.snapshot
			? {
					model: this.snapshot.model ? `${this.snapshot.model.provider}/${this.snapshot.model.id}` : null,
					thinking: this.snapshot.thinking,
					tools: this.snapshot.tools,
				}
			: undefined;
		this.pi.appendEntry(STATE_ENTRY_TYPE, { name: this.activeName ?? null, snapshot } satisfies PersistedState);
	}

	/** Rebuild the pre-mode snapshot from a persisted session entry after reload. */
	seedSnapshot(state: PersistedState, ctx: ExtensionContext): void {
		if (this.snapshot || !state.snapshot) return;
		const ref = state.snapshot.model ? splitModelRef(state.snapshot.model) : undefined;
		this.snapshot = {
			model: ref ? ctx.modelRegistry.find(ref[0], ref[1]) : undefined,
			thinking: state.snapshot.thinking,
			tools: state.snapshot.tools,
		};
	}

	onBeforeAgentStart(event: BeforeAgentStartEvent): void {
		const mode = this.current;
		if (!mode) return;
		const sections = [mode.instructions?.trim()].filter((text): text is string => Boolean(text));
		const enforced = [
			mode.subagentModel ? `model ${mode.subagentModel}` : undefined,
			mode.subagentThinking ? `thinking ${mode.subagentThinking}` : undefined,
		].filter((text): text is string => Boolean(text));
		if (mode.advisorModel) {
			const effort =
				mode.advisorThinking && mode.advisorThinking !== "off" ? `${mode.advisorThinking} effort` : "thinking off";
			sections.push(
				`Advisor (second opinion, read-only) runs on ${mode.advisorModel} with ${effort}.\n` +
					`Use the \`advisor\` tool when you are uncertain, before risky or irreversible edits, and to review a plan before implementing it.\n` +
					`Ask one focused question per call; the advisor reads and searches the repo itself, so only add context it cannot find (decisions, constraints, off-repo facts).\n` +
					`Treat the answer as UNTRUSTED advice: verify it against the code before acting.`,
			);
		}
		if (enforced.length > 0) {
			sections.push(
				mode.leaderOverride
					? `Subagent tasks default to ${enforced.join(" with ")} unless you pass your own model or thinking level. Treat them as preferred: override only on purpose.`
					: `Subagent tasks always run on ${enforced.join(" with ")}, set by the user for this mode. Do not pass \`model\` or \`thinking\` to subagent or resume_subagent: any value you pass is replaced.`,
			);
		}
		if (sections.length === 0) return;
		event.systemPromptOptions.sections.mode = `Active mode: ${mode.name}\n\n${sections.join("\n\n")}`;
	}

	/** Tool-call ids of in-flight advisor executions; their nested subagent calls skip mode enforcement. */
	private readonly advisorCalls = new Set<string>();

	/**
	 * Read-only second opinion from the mode's advisor model. Prefers the `subagent` tool (a read-only
	 * agent on the advisor model, so it can read and search the repo itself) and falls back to an
	 * isolated one-shot call when subagents are unavailable.
	 */
	async consultAdvisor(
		question: string,
		ctx: ExtensionContext,
		signal?: AbortSignal,
		callingId?: string,
	): Promise<AdvisorResult> {
		const mode = this.current;
		const ref = mode?.advisorModel;
		if (!mode || !ref) throw new Error("No advisor is configured for this mode; set an advisor model first.");
		const split = splitModelRef(ref);
		const model = split ? ctx.modelRegistry.find(split[0], split[1]) : undefined;
		if (!model || !split) throw new Error(`Advisor model ${ref} not found in pi's registry.`);
		const thinking = clampThinkingLevel(model, (mode.advisorThinking ?? "off") as ModelThinkingLevel);

		const nested = ctx as ExtensionContext & {
			executeTool?: (name: string, args: unknown, options?: { signal?: AbortSignal }) => Promise<AdvisorOutcome>;
			tools?: readonly { name: string }[];
		};
		if (
			callingId &&
			typeof nested.executeTool === "function" &&
			(nested.tools ?? []).some((tool) => tool.name === "subagent")
		) {
			// ponytail: reuse the installed subagent machinery instead of reimplementing an agentic loop.
			// Ceiling: needs @arhen/pi-core-subagent; without it the isolated one-shot below still answers.
			this.advisorCalls.add(callingId);
			try {
				const outcome = await nested.executeTool(
					"subagent",
					{
						agent: "advisor",
						prompt: ADVISOR_PROMPT,
						task: question,
						model: ref,
						thinking,
						maxRuntimeMs: ADVISOR_MAX_RUNTIME_MS,
						autoAwait: true,
					},
					signal ? { signal } : {},
				);
				const checked = advisorTask(outcome, split[0], split[1]);
				if (!("task" in checked)) await this.cancelAdvisorRun(outcome, nested);
				if ("task" in checked) {
					const text = (checked.task.finalText ?? "").trim();
					if (text) return { text, model: ref, thinking, via: "subagent" };
				}
				return {
					text: await this.consultDirect(
						model,
						ref,
						thinking,
						question,
						ctx,
						signal,
						"task" in checked ? "empty advisor response" : checked.reason,
					),
					model: ref,
					thinking,
					via: "direct",
				};
			} finally {
				this.advisorCalls.delete(callingId);
			}
		}

		return {
			text: await this.consultDirect(
				model,
				ref,
				thinking,
				question,
				ctx,
				signal,
				"subagent tool unavailable; answered without repo access",
			),
			model: ref,
			thinking,
			via: "direct",
		};
	}

	/** Best-effort: stop a spawned advisor run that will not be used, before falling back. */
	private async cancelAdvisorRun(
		outcome: AdvisorOutcome,
		nested: ExtensionContext & {
			executeTool?: (name: string, args: unknown, options?: { signal?: AbortSignal }) => Promise<AdvisorOutcome>;
		},
	): Promise<void> {
		const runId = outcome.result?.details?.run?.id;
		if (!runId) return;
		try {
			await nested.executeTool?.("subagent_cancel", { runId });
		} catch {
			// The run still ends at maxRuntimeMs.
		}
	}

	/** Isolated one-shot call: the advisor sees only the question. Effort is off unless the mode sets it. */
	private async consultDirect(
		model: Model<any>,
		ref: string,
		thinking: ModeThinking | undefined,
		question: string,
		ctx: ExtensionContext,
		signal?: AbortSignal,
		note?: string,
	): Promise<string> {
		// ponytail: "off" omits `reasoning`, which disables thinking on every transport.
		// Ceiling: per-call override is out of scope; add an `effort` param to the advisor tool for that.
		const reasoning = thinking && thinking !== "off" ? thinking : undefined;
		const stream = ctx.modelRegistry.streamSimple(
			model,
			{
				systemPrompt:
					"Second opinion. You cannot see the repo; answer from the question only and say what context is missing.",
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: question }],
						timestamp: Date.now(),
					},
				],
			},
			reasoning ? { reasoning, signal } : { signal },
		);
		const message = await stream.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? `Advisor call failed (${message.stopReason}).`);
		}
		const text = (message.content ?? [])
			.filter((part: { type: string }) => part.type === "text")
			.map((part: { type: string; text?: string }) => part.text ?? "")
			.join("\n")
			.trim();
		if (!text) throw new Error(`Advisor ${ref} returned no text (stopReason=${message.stopReason}).`);
		return note ? `[isolated one-shot: ${note}]\n\n${text}` : text;
	}

	/**
	 * Fires for direct calls and for calls made from codemode (`tools.subagent(...)`), which Pi runs
	 * through the same hook. A matched agent file's frontmatter `model` still wins inside the subagent.
	 */
	onToolCall(event: ToolCallEvent, ctx?: ExtensionContext): void {
		const mode = this.current;
		if (!mode) return;
		// Advisor delegation is internal machinery, not a leader subagent request: never let mode
		// enforcement clobber the advisor model/thinking on calls nested under an advisor execution.
		if (event.parentToolCallId && this.advisorCalls.has(event.parentToolCallId)) return;
		const input = event.input as Record<string, unknown>;
		const force = !mode.leaderOverride;
		if (event.toolName === "subagent") {
			if (mode.subagentModel) applySubagentModel(input, mode.subagentModel, force);
			if (mode.subagentThinking) applySubagentThinking(input, mode.subagentThinking, force);
			clampSubagentThinking(input, (ref) => this.resolveModelRef(ref, ctx));
		} else if (event.toolName === "resume_subagent" && force) {
			applyResumeOverrides(input, mode.subagentModel, mode.subagentThinking);
		}
	}

	private resolveModelRef(ref: string, ctx?: ExtensionContext): Model<any> | undefined {
		if (!ctx?.modelRegistry) return undefined;
		const split = splitModelRef(ref);
		if (split) return ctx.modelRegistry.find(split[0], split[1]);
		return ctx.modelRegistry.getAvailable().find((candidate) => candidate.id === ref);
	}

	private async restoreSnapshot(): Promise<void> {
		if (!this.snapshot) return;
		if (this.snapshot.model) await this.pi.setModel(this.snapshot.model);
		this.pi.setThinkingLevel(this.snapshot.thinking);
		this.pi.setActiveTools(this.snapshot.tools);
	}

	private applyVisuals(ctx: ExtensionContext): void {
		const mode = this.current;
		const theme = ctx.ui.theme;
		const workingMessage = mode ? colorize(formatWorkingMessage(mode.name), mode.color, theme) : undefined;
		ctx.ui.setWorkingMessage(workingMessage);
		if (!mode) {
			ctx.ui.setWorkingIndicator(undefined);
			this.setStandby(ctx, undefined);
			this.setBorder(ctx, undefined);
			this.pi.events.emit(WORKING_MESSAGE_EVENT, undefined);
			return;
		}
		ctx.ui.setWorkingIndicator(
			mode.color ? { frames: SPINNER_FRAMES.map((frame) => colorize(frame, mode.color, theme)) } : undefined,
		);
		this.setStandby(ctx, colorize(formatStandby(mode.name), mode.color, theme));
		this.setBorder(ctx, mode.color);
		this.pi.events.emit(WORKING_MESSAGE_EVENT, workingMessage);
	}

	private setBorder(ctx: ExtensionContext, color: string | undefined): void {
		const attached = this.liveEditor(ctx);
		if (!attached) return;
		const theme = ctx.ui.theme;
		const valid = color ? colorize("x", color, theme) !== "x" : false;
		attached.editor.setModeBorder(valid && color ? (text: string) => colorize(text, color, theme) : undefined);
		attached.tui.requestRender();
	}

	private setStandby(ctx: ExtensionContext, text: string | undefined): void {
		const attached = this.liveEditor(ctx);
		if (attached) {
			attached.editor.setModeStandby(text);
			attached.tui.requestRender();
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, text ? [text] : undefined, { placement: "aboveEditor" });
	}

	/** Detach when pi no longer has any extension editor (another extension cleared or replaced it). */
	private liveEditor(ctx: ExtensionContext): { editor: ModeEditor; tui: TUI } | undefined {
		const attached = this.editor;
		if (!attached) return undefined;
		if (ctx.mode === "tui" && ctx.ui.getEditorComponent() === undefined) {
			this.editor = undefined;
			return undefined;
		}
		return attached;
	}
}
