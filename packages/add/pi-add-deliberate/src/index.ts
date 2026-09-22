/**
 * @arhen/pi-add-deliberate — deliberate advise/plan modes.
 *
 * Reuses the installed `@arhen/pi-core-subagent` extension: this package never
 * spawns child sessions itself and never invokes extension tools directly. The
 * `/advise` and `/plan` commands expand the bundled skills, and the main agent
 * makes exactly one `subagent` tool call after `deliberate_mode prepare`.
 *
 * Config: `${getAgentDir()}/deliberate.json`, strictly validated on read.
 */

import { readFile } from "node:fs/promises";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	allowedTools,
	atomicWriteFile,
	CONFIG_FILE_NAME,
	clearConfig,
	clearMode,
	DEFAULT_PLAN_PATH,
	type DeliberateConfig,
	type DeliberateMode,
	type DeliberateModeConfig,
	type DeliberatePlanConfig,
	errorText,
	filterTools,
	latestPlanEntry,
	loadConfig,
	planWidgetLines,
	resolvePlanPath,
	type SavedPlanState,
	saveConfig,
	validatePlanMarkdown,
} from "./config.ts";
import {
	isInconclusivePreflight,
	modelRef,
	resolveThinkingLevel,
	selectableModels,
	supportedThinkingLevels,
} from "./models.ts";
import { PlanViewer } from "./viewer.ts";

type PrepareStatus = "unconfigured" | "dependency-missing" | "model-unavailable" | "ready";

interface DeliberateStatus {
	status: PrepareStatus | "configured" | "cancelled" | "configure-requires-ui";
	mode: DeliberateMode;
	reason?: string;
	message?: string;
	command?: string;
	model?: string;
	provider?: string;
	id?: string;
	thinking?: ModelThinkingLevel;
	tools?: string[];
	path?: string;
	configPath?: string;
	config?: DeliberateModeConfig | DeliberatePlanConfig;
}

function toolResult(payload: DeliberateStatus): {
	content: { type: "text"; text: string }[];
	details: DeliberateStatus;
} {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
}

function subagentToolState(pi: ExtensionAPI): "ok" | "missing" | "inactive" {
	const registered = pi.getAllTools().some((tool) => tool.name === "subagent");
	if (!registered) return "missing";
	return pi.getActiveTools().includes("subagent") ? "ok" : "inactive";
}

async function prepareMode(
	pi: ExtensionAPI,
	mode: DeliberateMode,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<DeliberateStatus> {
	const loaded = await loadConfig(getAgentDir());
	const modeConfig = mode === "advise" ? loaded.config?.advise : loaded.config?.plan;
	if (!modeConfig) {
		return {
			status: "unconfigured",
			mode,
			reason: loaded.error ? "invalid-config" : "missing-config",
			message: loaded.error
				? `deliberate config is invalid (${loaded.error})`
				: `deliberate ${mode} mode is not configured`,
			command: `/deliberate-config ${mode}`,
		};
	}

	const subagent = subagentToolState(pi);
	if (subagent !== "ok") {
		return {
			status: "dependency-missing",
			mode,
			reason: subagent,
			message:
				subagent === "missing"
					? "the subagent tool is not registered; install @arhen/pi-core-subagent"
					: "the subagent tool is registered but inactive; enable it before delegating",
		};
	}

	if (!modeConfig.model) {
		return {
			status: "model-unavailable",
			mode,
			reason: "missing-model",
			message: `no model configured for deliberate ${mode}; run /deliberate-config ${mode}`,
		};
	}
	const ref = modelRef(modeConfig.model);
	const model = ctx.modelRegistry.find(modeConfig.model.provider, modeConfig.model.id);
	if (!model) {
		return {
			status: "model-unavailable",
			mode,
			reason: "not-loaded",
			model: ref,
			message: `configured model ${ref} is not loaded/available`,
		};
	}

	const thinking = resolveThinkingLevel(model, modeConfig.thinking);
	const tools = filterTools(mode, modeConfig.tools);

	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: "ping" }], timestamp: Date.now() }] },
			{ maxTokens: 16, signal },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			const message = response.errorMessage ?? `preflight failed (${response.stopReason})`;
			if (!isInconclusivePreflight(model.provider, message)) {
				return {
					status: "model-unavailable",
					mode,
					reason: "preflight-failed",
					model: ref,
					thinking,
					tools,
					message,
				};
			}
		}
	} catch (error) {
		const message = errorText(error);
		if (!isInconclusivePreflight(model.provider, message)) {
			return {
				status: "model-unavailable",
				mode,
				reason: "preflight-failed",
				model: ref,
				thinking,
				tools,
				message: `preflight failed: ${message}`,
			};
		}
	}

	const status: DeliberateStatus = {
		status: "ready",
		mode,
		model: ref,
		provider: model.provider,
		id: model.id,
		thinking,
		tools,
	};
	if (mode === "plan") status.path = resolvePlanPath((modeConfig as DeliberatePlanConfig).path, ctx.cwd);
	return status;
}

function cancelledStatus(mode: DeliberateMode, config: DeliberateModeConfig | DeliberatePlanConfig): DeliberateStatus {
	return { status: "cancelled", mode, config, message: "configuration unchanged" };
}

async function configureMode(mode: DeliberateMode, ctx: ExtensionContext): Promise<DeliberateStatus> {
	const agentDir = getAgentDir();
	const loaded = await loadConfig(agentDir);
	const existing: DeliberateModeConfig | DeliberatePlanConfig =
		(mode === "advise" ? loaded.config?.advise : loaded.config?.plan) ?? {};

	const models = selectableModels(ctx.scopedModels, ctx.modelRegistry.getAvailable());
	if (models.length === 0) {
		return {
			status: "model-unavailable",
			mode,
			message: "no usable models available; configure a provider or model scope first",
		};
	}

	const currentRef = existing.model ? modelRef(existing.model) : undefined;
	const modelLabels = models.map((model) => `${modelRef(model)}${modelRef(model) === currentRef ? " (current)" : ""}`);
	const modelChoice = await ctx.ui.select(`Deliberate ${mode}: choose model`, modelLabels);
	if (modelChoice === undefined) return cancelledStatus(mode, existing);
	const model: Model<any> | undefined = models[modelLabels.indexOf(modelChoice)];
	if (!model) return cancelledStatus(mode, existing);

	const levels = supportedThinkingLevels(model);
	const thinkingLabels = levels.map((level) => `${level}${level === existing.thinking ? " (current)" : ""}`);
	const thinkingChoice = await ctx.ui.select(`Deliberate ${mode}: thinking level`, thinkingLabels);
	if (thinkingChoice === undefined) return cancelledStatus(mode, existing);
	const thinking = levels[thinkingLabels.indexOf(thinkingChoice)] ?? resolveThinkingLevel(model, existing.thinking);

	const tools = filterTools(mode, existing.tools);
	const toolsText = await ctx.ui.editor(
		`Deliberate ${mode}: tools (comma-separated; allowed: ${allowedTools(mode).join(", ")})`,
		tools.join(", "),
	);
	if (toolsText === undefined) return cancelledStatus(mode, existing);
	const nextTools = filterTools(mode, toolsText.split(/[\s,]+/).filter(Boolean));

	let path: string | undefined;
	if (mode === "plan") {
		const planConfig = existing as DeliberatePlanConfig;
		const pathText = await ctx.ui.editor(
			"Deliberate plan: output path (relative to cwd, ~/, or absolute)",
			planConfig.path ?? DEFAULT_PLAN_PATH,
		);
		if (pathText === undefined) return cancelledStatus(mode, existing);
		path = pathText.trim() || DEFAULT_PLAN_PATH;
	}

	const nextModeConfig: DeliberatePlanConfig = {
		model: { provider: model.provider, id: model.id },
		thinking,
		tools: nextTools,
		...(path ? { path } : {}),
	};
	const nextConfig: DeliberateConfig = { ...(loaded.config ?? {}), [mode]: nextModeConfig };
	const configPath = await saveConfig(agentDir, nextConfig);
	return {
		status: "configured",
		mode,
		model: modelRef(model),
		provider: model.provider,
		id: model.id,
		thinking,
		tools: nextTools,
		path,
		configPath,
		config: nextModeConfig,
	};
}

function refreshPlanUi(ctx: ExtensionContext): void {
	const plan = latestPlanEntry(ctx.sessionManager.getBranch());
	if (!plan) {
		ctx.ui.setWidget("deliberate-plan", undefined);
		ctx.ui.setStatus("deliberate-plan", undefined);
		return;
	}
	const theme = ctx.ui.theme;
	const lines = planWidgetLines(plan).map((line, index) =>
		index === 0 ? theme.fg("accent", line) : theme.fg("dim", line),
	);
	ctx.ui.setWidget("deliberate-plan", lines);
	ctx.ui.setStatus("deliberate-plan", theme.fg("accent", "plan"));
}

async function viewSavedPlan(ctx: ExtensionContext): Promise<void> {
	const plan = latestPlanEntry(ctx.sessionManager.getBranch());
	if (!plan) {
		ctx.ui.notify("No saved deliberate plan yet. Run /plan first.", "warning");
		return;
	}

	let content: string;
	try {
		content = await readFile(plan.path, "utf8");
	} catch {
		ctx.ui.notify(`Plan file not found: ${plan.path}`, "warning");
		return;
	}

	const loaded = await loadConfig(getAgentDir());
	const configuredPath = resolvePlanPath(loaded.config?.plan?.path, ctx.cwd);
	const warning =
		plan.path !== configuredPath
			? `Saved plan path differs from the configured path (${configuredPath}); showing the saved plan.`
			: undefined;

	if (ctx.mode !== "tui") {
		ctx.ui.notify(warning ? `${warning} Plan: ${plan.path}` : `Plan: ${plan.path}`, warning ? "warning" : "info");
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new PlanViewer({
				tui,
				theme,
				markdownTheme: getMarkdownTheme(),
				title: "Deliberate plan",
				path: plan.path,
				content,
				warning,
				onClose: () => done(undefined),
			}),
		{ overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
	);
}

async function showStatus(ctx: ExtensionContext): Promise<void> {
	const loaded = await loadConfig(getAgentDir());
	const lines = [`Deliberate config: ${loaded.path}`];
	if (loaded.error) lines.push(`invalid: ${loaded.error}`);
	for (const mode of ["advise", "plan"] as const) {
		const modeConfig = mode === "advise" ? loaded.config?.advise : loaded.config?.plan;
		if (!modeConfig) {
			lines.push(`${mode}: unconfigured`);
			continue;
		}
		const parts = [
			`model=${modeConfig.model ? modelRef(modeConfig.model) : "(none)"}`,
			`thinking=${modeConfig.thinking ?? "off"}`,
			`tools=${filterTools(mode, modeConfig.tools).join(",")}`,
		];
		if (mode === "plan") {
			const rawPath = (modeConfig as DeliberatePlanConfig).path;
			parts.push(`path=${rawPath ?? DEFAULT_PLAN_PATH} -> ${resolvePlanPath(rawPath, ctx.cwd)}`);
		}
		lines.push(`${mode}: ${parts.join(" ")}`);
	}
	ctx.ui.notify(lines.join("\n"), loaded.error ? "warning" : "info");
}

function notifyConfigureResult(ctx: ExtensionContext, result: DeliberateStatus): void {
	if (result.status === "configured") {
		const details = [
			`model=${result.model}`,
			`thinking=${result.thinking}`,
			`tools=${result.tools?.join(",")}`,
			result.path ? `path=${result.path}` : "",
		]
			.filter(Boolean)
			.join(" ");
		ctx.ui.notify(`Deliberate ${result.mode} configured: ${details}`, "info");
		return;
	}
	if (result.status === "cancelled") {
		ctx.ui.notify(`Deliberate ${result.mode} config unchanged.`, "info");
		return;
	}
	ctx.ui.notify(result.message ?? `Deliberate ${result.mode} was not configured.`, "warning");
}

const CONFIG_USAGE = "Usage: /deliberate-config [advise|plan|status|clear [advise|plan]]";

async function configureModeWithNotify(mode: DeliberateMode, ctx: ExtensionContext): Promise<void> {
	try {
		notifyConfigureResult(ctx, await configureMode(mode, ctx));
	} catch (error) {
		ctx.ui.notify(`Configure failed: ${errorText(error)}`, "error");
	}
}

async function clearModeWithNotify(mode: DeliberateMode, ctx: ExtensionContext): Promise<void> {
	try {
		const agentDir = getAgentDir();
		const next = clearMode((await loadConfig(agentDir)).config, mode);
		if (!next) {
			await clearConfig(agentDir);
			ctx.ui.notify(`Cleared deliberate ${mode} mode; config is empty, removed ${CONFIG_FILE_NAME}.`, "info");
			return;
		}
		await saveConfig(agentDir, next);
		ctx.ui.notify(`Cleared deliberate ${mode} mode; the other mode is preserved.`, "info");
	} catch (error) {
		ctx.ui.notify(`Clear failed: ${errorText(error)}`, "error");
	}
}

async function chooseClearMode(ctx: ExtensionContext): Promise<DeliberateMode | undefined> {
	const choice = await ctx.ui.select("Deliberate config: clear which mode?", ["advise", "plan"]);
	return choice === "advise" || choice === "plan" ? choice : undefined;
}

function registerSkillDispatch(pi: ExtensionAPI, command: "advise" | "plan", skill: string, description: string): void {
	pi.registerCommand(command, {
		description,
		handler: async (args, ctx) => {
			const skillCommand = pi
				.getCommands()
				.find((entry) => entry.source === "skill" && entry.name === `skill:${skill}`);
			if (!skillCommand) {
				ctx.ui.notify(`Skill "${skill}" is not loaded; /${command} cannot run.`, "error");
				return;
			}
			const text = `/skill:${skill}${args.trim() ? ` ${args.trim()}` : ""}`;
			pi.sendUserMessage(text, {
				expandPromptTemplates: true,
				...(ctx.isIdle() ? {} : { deliverAs: "followUp" }),
			});
		},
	});
}

export default function deliberateExtension(pi: ExtensionAPI): void {
	registerSkillDispatch(pi, "advise", "deliberate-advise", "Second opinion from a configured read-only subagent");
	registerSkillDispatch(
		pi,
		"plan",
		"deliberate-plan",
		"Research-first implementation plan, saved to the configured path",
	);

	pi.registerCommand("deliberate-config", {
		description: "Configure deliberate advise/plan modes (model, thinking, tools, plan path)",
		getArgumentCompletions: (prefix) => {
			const values = prefix.trimStart().startsWith("clear ")
				? ["clear advise", "clear plan"].filter((value) => value.startsWith(prefix))
				: ["advise", "plan", "status", "clear"].filter((value) => value.startsWith(prefix));
			const items = values.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const head = tokens[0] ?? "";
			const tail = tokens[1];
			if (!head) {
				if (!ctx.hasUI) {
					ctx.ui.notify(CONFIG_USAGE, "warning");
					return;
				}
				const choice = await ctx.ui.select("Deliberate config", [
					"Configure advise",
					"Configure plan",
					"Status",
					"Clear mode",
				]);
				if (choice === "Configure advise") await configureModeWithNotify("advise", ctx);
				else if (choice === "Configure plan") await configureModeWithNotify("plan", ctx);
				else if (choice === "Status") await showStatus(ctx);
				else if (choice === "Clear mode") {
					const mode = await chooseClearMode(ctx);
					if (mode) await clearModeWithNotify(mode, ctx);
				}
				return;
			}
			if (head === "status") {
				if (tail) {
					ctx.ui.notify(CONFIG_USAGE, "warning");
					return;
				}
				await showStatus(ctx);
				return;
			}
			if (head === "advise" || head === "plan") {
				if (tail) {
					ctx.ui.notify(CONFIG_USAGE, "warning");
					return;
				}
				await configureModeWithNotify(head, ctx);
				return;
			}
			if (head === "clear") {
				if (tail === "advise" || tail === "plan") {
					await clearModeWithNotify(tail, ctx);
					return;
				}
				if (tail || !ctx.hasUI) {
					ctx.ui.notify(CONFIG_USAGE, "warning");
					return;
				}
				const mode = await chooseClearMode(ctx);
				if (mode) await clearModeWithNotify(mode, ctx);
				return;
			}
			ctx.ui.notify(CONFIG_USAGE, "warning");
		},
	});

	pi.registerCommand("plan-view", {
		description: "View the saved deliberate plan",
		handler: async (_args, ctx) => {
			await viewSavedPlan(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "View the saved deliberate plan",
		handler: async (ctx) => {
			await viewSavedPlan(ctx);
		},
	});

	pi.registerTool({
		name: "deliberate_mode",
		label: "Deliberate Mode",
		description:
			"Prepare or configure the deliberate advise/plan modes. action=prepare validates config, the subagent tool, the configured model and provider connectivity, and returns a machine-readable status (unconfigured | dependency-missing | model-unavailable | ready). action=configure opens the model/thinking/tools/path picker and saves config; it requires interactive UI.",
		promptSnippet: "Prepare or configure a deliberate advise/plan subagent run",
		promptGuidelines: [
			"Use deliberate_mode with action=prepare before delegating a deliberate advise or plan run; never spawn the deliberate subagent before prepare returns ready.",
			"Use deliberate_mode with action=configure only when the user asks to change deliberate settings; it opens the configuration UI and requires interactive mode.",
		],
		parameters: Type.Object({
			mode: StringEnum(["advise", "plan"] as const, { description: "Deliberate mode to prepare or configure" }),
			action: StringEnum(["prepare", "configure"] as const, {
				description: "prepare validates readiness; configure opens the picker UI and saves config",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.action === "configure") {
				if (!ctx.hasUI) {
					return toolResult({
						status: "configure-requires-ui",
						mode: params.mode,
						message: `configuration requires interactive UI; run /deliberate-config ${params.mode}`,
					});
				}
				return toolResult(await configureMode(params.mode, ctx));
			}
			return toolResult(await prepareMode(pi, params.mode, ctx, signal ?? ctx.signal));
		},
	});

	pi.registerTool({
		name: "deliberate_save_plan",
		label: "Deliberate Save Plan",
		description:
			"Save the final implementation plan as standalone Markdown to the configured deliberate plan path. The path comes from config; this tool never accepts a path. Writes atomically and records the saved plan in the session.",
		promptSnippet: "Save the finished implementation plan to the configured plan path",
		promptGuidelines: [
			"Use deliberate_save_plan after a plan is finalized (deliberate subagent, custom subagent, or main agent); pass the complete standalone Markdown plan and do not choose the path.",
			"After deliberate_save_plan succeeds, report the returned path and tell the user to view it with /plan-view (Ctrl+Alt+P).",
		],
		parameters: Type.Object({
			markdown: Type.String({ description: "Final standalone Markdown plan" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const loaded = await loadConfig(getAgentDir());
			const planConfig = loaded.config?.plan;
			if (!planConfig) {
				throw new Error(
					`deliberate plan mode is not configured; run /deliberate-config plan${loaded.error ? ` (config error: ${loaded.error})` : ""}`,
				);
			}
			const empty = validatePlanMarkdown(params.markdown);
			if (empty) throw new Error(empty);
			const path = resolvePlanPath(planConfig.path, ctx.cwd);
			await withFileMutationQueue(path, async () => {
				await atomicWriteFile(path, params.markdown.endsWith("\n") ? params.markdown : `${params.markdown}\n`);
			});
			const savedAt = new Date().toISOString();
			pi.appendEntry("deliberate-plan", { path, savedAt });
			refreshPlanUi(ctx);
			return {
				content: [{ type: "text" as const, text: `Saved plan to ${path}. View it with /plan-view (Ctrl+Alt+P).` }],
				details: { path, savedAt },
			};
		},
	});

	pi.registerEntryRenderer<SavedPlanState>("deliberate-plan", (entry, options, theme) => {
		const path = entry.data?.path ?? "(unknown path)";
		let text = `${theme.fg("success", "✓ plan saved ")}${theme.fg("accent", path)}`;
		if (options.expanded && entry.data?.savedAt) text += `\n${theme.fg("dim", `saved ${entry.data.savedAt}`)}`;
		return new Text(text, 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshPlanUi(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshPlanUi(ctx);
	});
}
