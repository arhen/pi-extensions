import { mock } from "bun:test";
import { EventEmitter } from "node:events";
import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	ReadonlyFooterDataProvider,
	SessionEntry,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import senja from "../src/index.ts";
import palette from "../themes/senja.json";

type DisposableComponent = Component & { dispose?(): void };
type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

export function createHarness(mode: ExtensionContext["mode"] = "tui") {
	const bus = new EventEmitter();
	const events = {
		emit: (channel: string, data: unknown) => {
			bus.emit(channel, data);
		},
		on: (channel: string, handler: (data: unknown) => void) => {
			bus.on(channel, handler);
			return () => {
				bus.off(channel, handler);
			};
		},
	};
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const roles: Array<[ThemeColor, string]> = [];
	const theme = {
		fg(role: ThemeColor, text: string) {
			roles.push([role, text]);
			const variable = palette.colors[role as keyof typeof palette.colors];
			const hex = palette.vars[variable as keyof typeof palette.vars];
			const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
			return `\x1b[38;2;${rgb.join(";")}m${text}\x1b[39m`;
		},
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as Theme;
	const render = mock(() => {});
	const tui = { requestRender: render } as unknown as TUI;
	const subscribers = new Set<() => void>();
	const statuses = new Map<string, string>();
	let branch: string | null = "main";
	let sessionName: string | undefined = "test-session";
	let cwd = "/project";
	let level = "high";
	let usage: ContextUsage | undefined;
	let entries: SessionEntry[] = [];
	let footer: DisposableComponent | undefined;
	let header: DisposableComponent | undefined;
	let themeResult = { success: true, error: undefined as string | undefined };
	let footerFactory: Parameters<ExtensionUIContext["setFooter"]>[0];
	let headerFactory: Parameters<ExtensionUIContext["setHeader"]>[0];
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => branch,
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange(callback) {
			subscribers.add(callback);
			return () => subscribers.delete(callback);
		},
	};
	const ui = {
		theme,
		setWidget: mock(() => {}),
		setWorkingIndicator: mock(() => {}),
		setFooter: mock((factory: typeof footerFactory) => {
			footer?.dispose?.();
			footerFactory = factory;
			footer = factory?.(tui, theme, footerData);
		}),
		setHeader: mock((factory: typeof headerFactory) => {
			header?.dispose?.();
			headerFactory = factory;
			header = factory?.(tui, theme);
		}),
		setTheme: mock((_name: string | Theme) => themeResult),
		notify: mock((_message: string, _type?: string) => {}),
		setWorkingMessage: mock((_message?: string) => {}),
		setWorkingVisible: mock((_visible: boolean) => {}),
	};
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		ui,
		cwd,
		model: {
			provider: "anthropic",
			id: "claude-test",
			reasoning: true,
			contextWindow: 200_000,
		},
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getCwd: () => cwd,
			getSessionName: () => sessionName,
			getEntries: () => entries,
		},
		getContextUsage: () => usage,
	} as unknown as ExtensionContext;
	const api = {
		events,
		getActiveTools: () => ["read"],
		getAllTools: () => [{ name: "read" }],
		setActiveTools: mock(() => {}),
		setThinkingLevel: mock(() => {}),
		setModel: mock(async () => true),
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		getThinkingLevel: () => level,
	} as unknown as ExtensionAPI;
	senja(api);

	return {
		api,
		events,
		bus,
		ctx,
		ui,
		roles,
		render,
		statuses,
		subscribers,
		commands,
		get footer() {
			return footer;
		},
		get header() {
			return header;
		},
		setEntries(value: SessionEntry[]) {
			entries = value;
		},
		setUsage(value: ContextUsage | undefined) {
			usage = value;
		},
		setCwd(value: string) {
			cwd = value;
		},
		setBranch(value: string | null) {
			branch = value;
		},
		setSessionName(value: string | undefined) {
			sessionName = value;
		},
		setLevel(value: string) {
			level = value;
		},
		setThemeResult(value: typeof themeResult) {
			themeResult = value;
		},
		recreateFooter() {
			footer = footerFactory?.(tui, theme, footerData);
		},
		branchChanged() {
			for (const callback of subscribers) callback();
		},
		async emit(event: string, data: Record<string, unknown> = {}) {
			for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
		},
		async toggle() {
			await commands.get("senja")!.handler("", ctx as ExtensionCommandContext);
		},
	};
}

export function assistantEntry(
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	cost: number,
): SessionEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			usage: { input, output, cacheRead, cacheWrite, cost: { total: cost } },
		},
	} as SessionEntry;
}

export function plain(text: string): string {
	return text.replace(/\x1b\[[0-9;:]*m/g, "");
}
