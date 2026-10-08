import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Shortcut = Parameters<ExtensionAPI["registerShortcut"]>[1];

/**
 * Point pi's agent dir and the XDG cache at a fresh temp dir. Call before the
 * extension module is imported: extensions resolve their state paths at load.
 * Bun caches os.homedir() at startup, so overriding HOME at runtime does not work.
 */
export function isolateAgentDir(prefix: string): { root: string; agentDir: string; cacheDir: string } {
	const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
	const agentDir = join(root, "agent");
	const cacheHome = join(root, "cache");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.XDG_CACHE_HOME = cacheHome;
	return { root, agentDir, cacheDir: join(cacheHome, "pi") };
}

export function createFakePi() {
	const providers = new Map<string, ProviderConfig>();
	const registrations: Array<{ name: string; config: ProviderConfig }> = [];
	const unregistered: string[] = [];
	const commands = new Map<string, Command>();
	const shortcuts = new Map<string, Shortcut>();
	const handlers = new Map<string, Handler[]>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const userMessages: string[] = [];

	const known = {
		registerProvider(name: string, config: ProviderConfig) {
			providers.set(name, config);
			registrations.push({ name, config });
		},
		unregisterProvider(name: string) {
			providers.delete(name);
			unregistered.push(name);
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		registerShortcut(key: string, shortcut: Shortcut) {
			shortcuts.set(key, shortcut);
		},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		sendUserMessage(content: string) {
			userMessages.push(content);
		},
	};
	const api = new Proxy(known, {
		get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
	}) as unknown as ExtensionAPI;

	return {
		api,
		providers,
		registrations,
		unregistered,
		commands,
		shortcuts,
		entries,
		userMessages,
		async emit(event: string, payload: unknown, ctx: unknown) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
		async run(name: string, args: string, ctx: unknown) {
			const command = commands.get(name);
			if (!command) throw new Error(`command not registered: ${name}`);
			await command.handler(args, ctx as ExtensionCommandContext);
		},
	};
}

export interface FetchCall {
	url: string;
	headers: Record<string, string>;
}

/** Replace global fetch for the duration of a test; returns the recorded calls and a restore fn. */
export function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>) {
	const original = globalThis.fetch;
	const calls: FetchCall[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		const call = { url, headers };
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
	return {
		calls,
		restore() {
			globalThis.fetch = original;
		},
	};
}

export function createRefreshContext(overrides: Partial<RefreshModelsContext> = {}) {
	const published: unknown[] = [];
	const context: RefreshModelsContext = {
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async (publication) => {
			published.push(publication);
			return true;
		},
		...overrides,
	};
	return { context, published };
}

export interface FakeCtxOptions {
	select?: string[];
	input?: string[];
	model?: { provider?: string; id?: string };
	sessionEntries?: unknown[];
	registryModels?: unknown[];
}

export function createFakeCtx(options: FakeCtxOptions = {}) {
	const selects = [...(options.select ?? [])];
	const inputs = [...(options.input ?? [])];
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, unknown>();
	const refreshes: unknown[] = [];
	const ctx = {
		cwd: process.cwd(),
		model: options.model,
		signal: undefined,
		hasUI: true,
		sessionManager: { getEntries: () => options.sessionEntries ?? [] },
		modelRegistry: {
			refresh: async (opts: unknown) => {
				refreshes.push(opts);
			},
			getProvider: () => ({ getModels: () => options.registryModels ?? [] }),
		},
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			select: async () => selects.shift(),
			input: async () => inputs.shift(),
			confirm: async () => true,
			setStatus: (key: string, text: string | undefined) => {
				statuses.set(key, text);
			},
			setWidget: (key: string, content: unknown) => {
				widgets.set(key, content);
			},
		},
	};
	return { ctx, notifications, statuses, widgets, refreshes };
}
