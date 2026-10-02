import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { ModeEditor } from "./editor.ts";
import { ModeEngine, type PersistedState } from "./engine.ts";
import { cycleList, isDefaultModeName, nextInCycle } from "./logic.ts";
import { ModeStore } from "./store.ts";
import { DEFAULT_MODE_NAME, STATE_ENTRY_TYPE, WIDGET_KEY } from "./types.ts";
import { createMode, editMode, openModePanel, standaloneEditPicker } from "./ui.ts";

interface PersistedModeEntry {
	type?: string;
	customType?: string;
	data?: PersistedState;
}

export default function piMode(pi: ExtensionAPI): void {
	const engine = new ModeEngine(pi);
	let store: ModeStore | undefined;

	const requireStore = (ctx: ExtensionContext): ModeStore => {
		if (!store) {
			store = new ModeStore(ctx.cwd);
			store.load();
		}
		engine.setStore(store);
		return store;
	};

	const installEditor = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui" || ctx.ui.getEditorComponent() !== undefined) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new ModeEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			engine.attachEditor(editor, tui);
			return editor;
		});
	};

	const guardedSwitch = async (name: string | undefined, ctx: ExtensionContext): Promise<void> => {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Finish the current turn before switching modes", "warning");
			return;
		}
		await engine.switchTo(name, ctx);
	};

	const cycle = async (ctx: ExtensionContext, step: 1 | -1): Promise<void> => {
		const modes = requireStore(ctx);
		const target = nextInCycle(cycleList(modes.list()), engine.activeName, step);
		await guardedSwitch(target === DEFAULT_MODE_NAME ? undefined : target, ctx);
	};

	pi.registerFlag("start-mode", { description: "Start with this pi mode active", type: "string" });

	pi.registerShortcut(Key.alt("m"), {
		description: "Cycle pi modes",
		handler: (ctx) => cycle(ctx, 1),
	});

	// Aliases for terminals that report ctrl+tab and do not consume it.
	pi.registerShortcut(Key.ctrl("tab"), {
		description: "Cycle pi modes (ctrl+tab alias)",
		handler: (ctx) => cycle(ctx, 1),
	});

	pi.registerShortcut(Key.ctrlShift("tab"), {
		description: "Cycle pi modes backwards (alias)",
		handler: (ctx) => cycle(ctx, -1),
	});

	pi.registerCommand("mode", {
		description: "Switch, create or manage pi modes",
		getArgumentCompletions: (prefix) => {
			const values = [DEFAULT_MODE_NAME, ...(store?.names() ?? []), "list", "new", "edit", "off"];
			const items = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const modes = requireStore(ctx);
			const arg = args.trim();

			if (!arg) {
				await openModePanel(ctx, engine, modes);
				return;
			}
			if (arg === "list") {
				const lines = modes
					.list()
					.map(
						(mode) =>
							`${mode.name}${mode.enabled ? "" : " (disabled)"}${engine.activeName === mode.name ? " ← active" : ""}`,
					);
				ctx.ui.notify([`${DEFAULT_MODE_NAME} (built-in)`, ...lines].join("\n"), "info");
				return;
			}
			if (arg === "new") {
				await createMode(ctx, engine, modes);
				return;
			}
			if (arg === "edit") {
				const name = await standaloneEditPicker(ctx, modes);
				if (name) await editMode(ctx, engine, modes, name);
				return;
			}
			if (arg === "off") {
				await guardedSwitch(undefined, ctx);
				return;
			}
			await guardedSwitch(isDefaultModeName(arg) ? undefined : arg, ctx);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const modes = requireStore(ctx);
		installEditor(ctx);

		const flag = pi.getFlag("start-mode");
		const flagName = typeof flag === "string" ? flag.trim() : "";
		if (flagName) {
			if (isDefaultModeName(flagName)) {
				await engine.activate(undefined, ctx);
				engine.persistState();
				return;
			}
			if (!modes.get(flagName)) {
				ctx.ui.notify(`Unknown mode "${flagName}"`, "warning");
				return;
			}
			await engine.activate(flagName, ctx);
			engine.persistState();
			return;
		}

		if (event.reason === "new") {
			engine.reset(ctx);
			return;
		}
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as PersistedModeEntry;
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
			const data = entry.data;
			const name = data?.name;
			if (data) engine.seedSnapshot(data, ctx);
			if (typeof name === "string" && name && modes.get(name)) await engine.activate(name, ctx);
			else await engine.activate(undefined, ctx);
			return;
		}
	});

	pi.on("before_agent_start", (event) => {
		engine.onBeforeAgentStart(event);
	});

	pi.on("tool_call", (event) => {
		engine.onToolCall(event);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		engine.detachEditor();
		if (ctx.mode !== "tui") return;
		try {
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// UI is already tearing down.
		}
	});
}
