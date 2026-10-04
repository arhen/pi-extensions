import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import subagentExtension from "../../src/index.ts";
import { repoRoot } from "../../src/worktree.ts";

export const BASELINE_OPERATIONS = [
	"subagent",
	"subagent_status",
	"subagent_result",
	"await_subagent",
	"reply_subagent",
	"steer_subagent",
	"resume_subagent",
	"subagent_cancel",
] as const;

export type BaselineOperation = (typeof BASELINE_OPERATIONS)[number];

export interface Renderable {
	render(width: number): string[];
}

export interface ToolResult {
	content: { type: string; text?: string }[];
	isError?: boolean;
	details?: any;
}

export interface CapturedTool {
	name: string;
	label?: string;
	description: string;
	parameters: unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
	executionMode?: string;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: any,
		ctx: ExtensionContext,
	) => Promise<ToolResult>;
	renderCall?: (args: any, theme: Theme, context?: any) => Renderable;
	renderResult?: (result: any, options: { expanded: boolean }, theme: Theme, context?: any) => Renderable;
}

export interface CapturedCommand {
	description?: string;
	handler: (args: string, ctx: ExtensionContext) => unknown;
}

export interface CapturedShortcut {
	description?: string;
	handler: (ctx: ExtensionContext) => unknown;
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface EmittedEvent {
	type: string;
	payload: Record<string, unknown>;
}

export interface SentMessage {
	content: unknown;
	options?: Record<string, unknown>;
}

export interface Notification {
	message: string;
	level: string;
}

export interface ExtensionHarness {
	tools: Map<string, CapturedTool>;
	commands: Map<string, CapturedCommand>;
	shortcuts: Map<string, CapturedShortcut>;
	handlers: Map<string, EventHandler[]>;
	emitted: EmittedEvent[];
	sent: SentMessage[];
	notifications: Notification[];
	dir: string;
	sessionFile: string;
	sidecarFile: string;
	ctx(overrides?: Partial<Record<string, unknown>>): ExtensionContext;
	writeSidecar(text: string): void;
	startSession(): Promise<void>;
	restore(runs: unknown[]): Promise<void>;
	invoke(event: string, ctx?: ExtensionContext): Promise<void>;
	dispose(): Promise<void>;
}

export function createExtensionHarness(): ExtensionHarness {
	const dir = mkdtempSync(join(tmpdir(), "subagent-parity-"));
	const insideRepo = repoRoot(dir);
	if (insideRepo) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error(`parity harness refuses to run inside a git repo (${insideRepo})`);
	}
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, "");
	const sidecarFile = sessionFile.replace(/\.jsonl$/, ".subagents.json");

	const tools = new Map<string, CapturedTool>();
	const commands = new Map<string, CapturedCommand>();
	const shortcuts = new Map<string, CapturedShortcut>();
	const handlers = new Map<string, EventHandler[]>();
	const emitted: EmittedEvent[] = [];
	const sent: SentMessage[] = [];
	const notifications: Notification[] = [];

	const pi = {
		registerTool(tool: CapturedTool): void {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: CapturedCommand): void {
			commands.set(name, command);
		},
		registerShortcut(key: string, shortcut: CapturedShortcut): void {
			shortcuts.set(key, shortcut);
		},
		on(event: string, handler: EventHandler): void {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		events: {
			emit(type: string, payload: Record<string, unknown>): void {
				emitted.push({ type, payload });
			},
		},
		sendUserMessage(content: unknown, options?: Record<string, unknown>): void {
			sent.push({ content, options });
		},
	} as unknown as ExtensionAPI;

	subagentExtension(pi);

	const makeCtx = (overrides: Partial<Record<string, unknown>> = {}): ExtensionContext => {
		const base = {
			cwd: dir,
			hasUI: false,
			mode: "rpc",
			model: undefined,
			modelRegistry: {
				getAvailable: () => [],
				find: () => undefined,
				complete: async () => ({
					stopReason: "error",
					errorMessage: "parity harness has no provider",
				}),
			},
			sessionManager: { getSessionFile: () => sessionFile },
			ui: {
				notify: (message: string, level = "info"): void => {
					notifications.push({ message, level });
				},
				custom: async (): Promise<undefined> => undefined,
				setWidget: (): void => {},
			},
			signal: undefined,
			isIdle: () => true,
			isProjectTrusted: () => true,
			hasPendingMessages: () => false,
			shutdown: (): void => {},
			getContextUsage: (): undefined => undefined,
			compact: (): void => {},
			getSystemPrompt: () => "",
			abort: (): void => {},
		};
		return { ...base, ...overrides } as unknown as ExtensionContext;
	};

	const invoke = async (event: string, ctx?: ExtensionContext): Promise<void> => {
		const ctxToUse = ctx ?? makeCtx();
		for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctxToUse);
	};

	const writeSidecar = (text: string): void => {
		writeFileSync(sidecarFile, text);
	};

	return {
		tools,
		commands,
		shortcuts,
		handlers,
		emitted,
		sent,
		notifications,
		dir,
		sessionFile,
		sidecarFile,
		ctx: makeCtx,
		writeSidecar,
		startSession: () => invoke("session_start"),
		restore: async (runs: unknown[]): Promise<void> => {
			writeSidecar(JSON.stringify(runs, null, 2));
			await invoke("session_start");
		},
		invoke,
		dispose: async (): Promise<void> => {
			try {
				await invoke("session_shutdown");
			} catch {}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export function requireTool(h: ExtensionHarness, name: string): CapturedTool {
	const tool = h.tools.get(name);
	if (!tool) throw new Error(`Tool not registered by the extension: ${name}`);
	return tool;
}

export async function runTool(
	h: ExtensionHarness,
	name: string,
	params: unknown,
	ctx?: ExtensionContext,
): Promise<ToolResult> {
	const tool = requireTool(h, name);
	return tool.execute(`call_${name}`, params, undefined, undefined, ctx ?? h.ctx());
}

export function resultText(result: ToolResult): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

export const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

export function renderComponent(component: Renderable, width = 200): string {
	return component.render(width).join("\n");
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("parity: waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
