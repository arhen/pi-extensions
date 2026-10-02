import type { Model } from "@earendil-works/pi-ai";
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
	applySubagentModel,
	applySubagentThinking,
	formatStandby,
	formatWorkingMessage,
	resolveToolNames,
} from "./logic.ts";
import type { ModeStore } from "./store.ts";
import { DEFAULT_MODE_NAME, type Mode, STATE_ENTRY_TYPE, WIDGET_KEY } from "./types.ts";

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

		const known = this.pi.getAllTools().map((tool) => tool.name);
		this.pi.setActiveTools(resolveToolNames(target.tools, this.snapshot.tools, known));
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
		if (!mode?.instructions?.trim()) return;
		event.systemPromptOptions.sections.mode = `Active mode: ${mode.name}\n\n${mode.instructions.trim()}`;
	}

	onToolCall(event: ToolCallEvent): void {
		const mode = this.current;
		if (!mode || event.toolName !== "subagent") return;
		const input = event.input as Record<string, unknown>;
		if (mode.subagentModel) applySubagentModel(input, mode.subagentModel);
		if (mode.subagentThinking) applySubagentThinking(input, mode.subagentThinking);
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
		if (!mode) {
			ctx.ui.setWorkingMessage(undefined);
			ctx.ui.setWorkingIndicator(undefined);
			this.setStandby(ctx, undefined);
			this.setBorder(ctx, undefined);
			return;
		}
		ctx.ui.setWorkingMessage(colorize(formatWorkingMessage(mode.name), mode.color, theme));
		ctx.ui.setWorkingIndicator(
			mode.color ? { frames: SPINNER_FRAMES.map((frame) => colorize(frame, mode.color, theme)) } : undefined,
		);
		this.setStandby(ctx, colorize(formatStandby(mode.name), mode.color, theme));
		this.setBorder(ctx, mode.color);
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
