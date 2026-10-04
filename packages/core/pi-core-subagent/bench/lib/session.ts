import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	createEventBus,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { BenchMode, BenchOptions, CodemodeState } from "./args.ts";

export const SUBAGENT_PACKAGE = "@arhen/pi-core-subagent";

export interface ExtensionDescription {
	path: string;
	resolvedPath: string;
	source: string;
	tools: string[];
	commands: string[];
	flags: string[];
	shortcuts: string[];
}

export interface DuplicateTool {
	tool: string;
	extensions: string[];
}

export interface BuildTimings {
	modelRuntimeMs: number;
	settingsMs: number;
	loaderMs: number;
	sessionCreateMs: number;
	bindExtensionsMs: number;
	totalMs: number;
}

export interface ModelIdentity {
	provider: string;
	id: string;
	name: string;
	contextWindow: number | undefined;
	thinkingLevel: string;
}

export interface TargetInfo {
	path: string;
	exists: boolean;
	bytes: number | undefined;
	mtimeMs: number | undefined;
	sha256: string | undefined;
}

export interface SettingsDiagnostics {
	agentDir: string;
	packagesConfigured: string[];
	packagesLoaded: string[];
	packagesRemoved: string[];
	defaultToolsBefore: string[] | undefined;
	defaultToolsAfter: string[] | undefined;
	codemodeMode: string | undefined;
	codemodeNote: string;
	extensionsSetting: unknown;
}

export interface BuiltSession {
	session: AgentSession;
	extensions: ExtensionDescription[];
	duplicateTools: DuplicateTool[];
	model: ModelIdentity;
	modelRuntime: ModelRuntime;
	settings: SettingsDiagnostics;
	eventBus: ReturnType<typeof createEventBus>;
	timings: BuildTimings;
	providerRequests: ProviderRequestCapture[];
	dispose: () => void;
}

export interface ProviderToolDeclaration {
	name: string;
	descriptionChars: number;
	schemaChars: number;
}

export interface ProviderRequestCapture {
	atMs: number;
	model: string | undefined;
	toolCount: number | undefined;
	toolNames: string[] | undefined;
	toolsJsonBytes: number | undefined;
	perTool: ProviderToolDeclaration[] | undefined;
	messageCount: number | undefined;
	systemChars: number | undefined;
	payloadBytes: number;
	payloadHash: string;
}

function now(): number {
	return performance.now();
}

function packageSource(pkg: unknown): string {
	if (typeof pkg === "string") return pkg;
	if (
		pkg !== null &&
		typeof pkg === "object" &&
		typeof (pkg as { source?: unknown }).source === "string"
	) {
		return (pkg as { source: string }).source;
	}
	return "";
}

function normalizePackageName(source: string): string {
	return source.trim().replace(/^npm:/, "");
}

export function isSubagentPackage(pkg: unknown): boolean {
	return normalizePackageName(packageSource(pkg)) === SUBAGENT_PACKAGE;
}

export interface CodemodePlan {
	factory: ReturnType<typeof createCodemodeExtension> | undefined;
	modeOverride: "on" | "only" | undefined;
	defaultTools: string[] | undefined;
	note: string;
}

function withCodemodeEnabled(defaultTools: string[] | undefined): string[] {
	if (defaultTools === undefined) return ["+codemode"];
	if (defaultTools.some((tool) => tool === "codemode" || tool === "+codemode"))
		return defaultTools;
	const hasModifiers = defaultTools.some((tool) => /^[+-]/.test(tool));
	return [...defaultTools, hasModifiers ? "+codemode" : "codemode"];
}

export function planCodemode(
	state: CodemodeState,
	defaultTools: string[] | undefined,
): CodemodePlan {
	if (state === "disabled") {
		const filtered = defaultTools?.filter(
			(tool) => tool.replace(/^[+-]/, "") !== "codemode",
		);
		return {
			factory: undefined,
			modeOverride: undefined,
			defaultTools: filtered,
			note: `disabled: codemode factory omitted; defaultTools ${JSON.stringify(defaultTools ?? null)} -> ${JSON.stringify(filtered ?? null)}`,
		};
	}
	const mode = state === "active" ? undefined : state;
	const enabled = withCodemodeEnabled(defaultTools);
	return {
		factory: mode
			? createCodemodeExtension({ mode })
			: createCodemodeExtension(),
		modeOverride: mode,
		defaultTools: enabled,
		note:
			state === "active"
				? `active: factory added (settings mode kept); defaultTools ${JSON.stringify(defaultTools ?? null)} -> ${JSON.stringify(enabled)}`
				: `active(${mode}): factory mode=${mode}; defaultTools ${JSON.stringify(defaultTools ?? null)} -> ${JSON.stringify(enabled)}`,
	};
}

export function inspectTarget(path: string): TargetInfo {
	if (!existsSync(path))
		return {
			path,
			exists: false,
			bytes: undefined,
			mtimeMs: undefined,
			sha256: undefined,
		};
	const stat = statSync(path);
	const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
	return {
		path,
		exists: true,
		bytes: stat.size,
		mtimeMs: stat.mtimeMs,
		sha256,
	};
}

export function describeExtensions(extensionsResult: {
	extensions: Array<{
		path: string;
		resolvedPath: string;
		sourceInfo?: { source?: string } | undefined;
		tools: Map<string, unknown>;
		commands: Map<string, unknown>;
		flags: Map<string, unknown>;
		shortcuts: Map<string, unknown>;
	}>;
}): ExtensionDescription[] {
	return extensionsResult.extensions.map((ext) => ({
		path: ext.path,
		resolvedPath: ext.resolvedPath,
		source: ext.sourceInfo?.source ?? "unknown",
		tools: [...ext.tools.keys()].sort(),
		commands: [...ext.commands.keys()].sort(),
		flags: [...ext.flags.keys()].sort(),
		shortcuts: [...ext.shortcuts.keys()].sort(),
	}));
}

export function findDuplicateTools(
	extensions: ExtensionDescription[],
): DuplicateTool[] {
	const owners = new Map<string, string[]>();
	for (const ext of extensions) {
		for (const tool of ext.tools) {
			owners.set(tool, [...(owners.get(tool) ?? []), ext.path]);
		}
	}
	return [...owners.entries()]
		.filter(([, paths]) => paths.length > 1)
		.map(([tool, paths]) => ({ tool, extensions: paths }));
}

function summarizePayload(
	payload: unknown,
	atMs: number,
): ProviderRequestCapture {
	const text = JSON.stringify(payload);
	const hash = createHash("sha256").update(text).digest("hex");
	const root = payload as Record<string, unknown> | null;
	const toolsRaw =
		root && typeof root === "object"
			? (root.tools as unknown[] | undefined)
			: undefined;
	let toolNames: string[] | undefined;
	let perTool: ProviderToolDeclaration[] | undefined;
	let toolsJsonBytes: number | undefined;
	if (Array.isArray(toolsRaw)) {
		perTool = toolsRaw.map((tool) => {
			const entry = tool as {
				function?: {
					name?: unknown;
					description?: unknown;
					parameters?: unknown;
				};
				name?: unknown;
			};
			const name = String(entry.function?.name ?? entry.name ?? "?");
			const description = entry.function?.description;
			const parameters =
				entry.function?.parameters ??
				(tool as { input_schema?: unknown }).input_schema;
			return {
				name,
				descriptionChars:
					typeof description === "string" ? description.length : 0,
				schemaChars:
					parameters === undefined ? 0 : JSON.stringify(parameters).length,
			};
		});
		toolNames = perTool.map((tool) => tool.name);
		toolsJsonBytes = JSON.stringify(toolsRaw).length;
	}
	const messages =
		root && typeof root === "object"
			? (root.messages as unknown[] | undefined)
			: undefined;
	let systemChars: number | undefined;
	if (Array.isArray(messages)) {
		const system = messages.find(
			(message) => (message as { role?: unknown }).role === "system",
		) as { content?: unknown } | undefined;
		if (typeof system?.content === "string")
			systemChars = system.content.length;
		else if (Array.isArray(system?.content))
			systemChars = JSON.stringify(system.content).length;
	} else if (typeof root?.system === "string") {
		systemChars = root.system.length;
	}
	const model =
		root && typeof root === "object" && typeof root.model === "string"
			? root.model
			: undefined;
	return {
		atMs,
		model,
		toolCount: Array.isArray(toolsRaw) ? toolsRaw.length : undefined,
		toolNames,
		toolsJsonBytes,
		perTool,
		messageCount: Array.isArray(messages) ? messages.length : undefined,
		systemChars,
		payloadBytes: text.length,
		payloadHash: hash,
	};
}

export interface BuildSessionInput {
	opts: BenchOptions;
	phase?: (label: string, ms: number) => void;
}

export async function buildParentSession(
	input: BuildSessionInput,
): Promise<BuiltSession> {
	const { opts } = input;
	const t0 = now();
	const phase = (label: string, ms: number) => input.phase?.(label, ms);
	const agentDir = opts.agentDir ?? getAgentDir();

	const tRuntimeStart = now();
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: opts.modelRefresh === "network",
	});
	await runtime.refresh({ allowNetwork: opts.modelRefresh === "network" });
	const available = await runtime.getAvailable();
	const model = available.find(
		(candidate) =>
			candidate.provider === opts.provider && candidate.id === opts.model,
	);
	if (!model) {
		throw new Error(
			`model ${opts.provider}/${opts.model} not available from ${opts.modelRefresh} catalog (${available.length} models available)`,
		);
	}
	const modelRuntimeMs = now() - tRuntimeStart;
	phase("modelRuntime", modelRuntimeMs);

	const tSettingsStart = now();
	const fileSettings = SettingsManager.create(opts.cwd, agentDir);
	const effective = fileSettings.getSettings();
	const configuredPackages = (effective.packages ?? []).map(packageSource);
	const removedPackages = (effective.packages ?? [])
		.filter(isSubagentPackage)
		.map(packageSource);
	const keptPackages = (effective.packages ?? []).filter(
		(pkg) => !isSubagentPackage(pkg),
	);
	const codemodePlan = planCodemode(opts.codemode, effective.defaultTools);
	const settings = {
		...effective,
		packages: keptPackages,
		defaultTools: codemodePlan.defaultTools,
		...(codemodePlan.modeOverride
			? { codemode: { ...effective.codemode, mode: codemodePlan.modeOverride } }
			: {}),
	};
	const settingsManager = SettingsManager.inMemory(settings);
	const settingsMs = now() - tSettingsStart;
	phase("settings", settingsMs);

	const eventBus = createEventBus();
	const providerRequests: ProviderRequestCapture[] = [];
	const probeFactory: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => {
			try {
				providerRequests.push(summarizePayload(event.payload, now() - t0));
			} catch {
				// A malformed payload must not break the provider call being measured.
			}
		});
	};

	const tLoaderStart = now();
	const loader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir,
		settingsManager,
		eventBus,
		additionalExtensionPaths: opts.target ? [opts.target] : [],
		extensionFactories: [
			...(codemodePlan.factory ? [codemodePlan.factory] : []),
			{ name: "bench-probe", hidden: true, factory: probeFactory },
		],
	});
	await loader.reload();
	const loaderMs = now() - tLoaderStart;
	phase("loaderReload", loaderMs);

	const tSessionStart = now();
	const created = await createAgentSession({
		cwd: opts.cwd,
		agentDir,
		modelRuntime: runtime,
		model,
		thinkingLevel: opts.thinking as ThinkingLevel,
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
	});
	const sessionCreateMs = now() - tSessionStart;
	phase("createAgentSession", sessionCreateMs);

	const tBindStart = now();
	await created.session.bindExtensions({});
	const bindExtensionsMs = now() - tBindStart;
	phase("bindExtensions", bindExtensionsMs);

	const extensions = describeExtensions(created.extensionsResult);
	const duplicateTools = findDuplicateTools(extensions);
	const settingsDiagnostics: SettingsDiagnostics = {
		agentDir,
		packagesConfigured: configuredPackages,
		packagesLoaded: keptPackages.map(packageSource),
		packagesRemoved: removedPackages,
		defaultToolsBefore: effective.defaultTools,
		defaultToolsAfter: codemodePlan.defaultTools,
		codemodeMode: codemodePlan.modeOverride,
		codemodeNote: codemodePlan.note,
		extensionsSetting: effective.extensions,
	};

	const modelIdentity: ModelIdentity = {
		provider: model.provider,
		id: model.id,
		name: model.name,
		contextWindow: (model as { contextWindow?: number }).contextWindow,
		thinkingLevel: opts.thinking,
	};

	return {
		session: created.session,
		extensions,
		duplicateTools,
		model: modelIdentity,
		modelRuntime: runtime,
		settings: settingsDiagnostics,
		eventBus,
		timings: {
			modelRuntimeMs,
			settingsMs,
			loaderMs,
			sessionCreateMs,
			bindExtensionsMs,
			totalMs: now() - t0,
		},
		providerRequests,
		dispose: () => created.session.dispose(),
	};
}

export function commandRegistered(
	extensions: ExtensionDescription[],
	command: string,
): boolean {
	return extensions.some((ext) => ext.commands.includes(command));
}

export function ensureOutDir(file: string): void {
	const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
	if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function modeCommandText(
	template: string,
	mode: BenchMode,
): string | undefined {
	if (mode === "baseline") return undefined;
	const trimmed = template.trim();
	if (!trimmed) return undefined;
	return trimmed.replaceAll("{mode}", mode);
}
