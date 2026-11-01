import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isolateAgentDir } from "../../../../test-support/fake-pi.ts";
import {
	DEFAULT_TODO_CONFIG,
	flushTodoConfigWrites,
	readTodoConfig,
	TODO_CONFIG_FILENAME,
	writeTodoConfig,
} from "../src/config.ts";
import { TodoOverlay } from "../src/overlay.ts";
import { clearActiveRenderSession, commitState, setActiveRenderSession } from "../src/store.ts";
import type { Task, TaskState } from "../src/types.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousCacheHome = process.env.XDG_CACHE_HOME;
const { root, agentDir } = isolateAgentDir("todo-config");
mkdirSync(agentDir, { recursive: true });
const configFile = join(agentDir, TODO_CONFIG_FILENAME);

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = previousCacheHome;
	rmSync(root, { recursive: true, force: true });
});

function reset() {
	rmSync(configFile, { force: true });
}

describe("todo config file", () => {
	test("a missing or malformed file degrades to the defaults", () => {
		reset();
		expect(readTodoConfig()).toEqual(DEFAULT_TODO_CONFIG);
		writeFileSync(configFile, "{ nope");
		expect(readTodoConfig()).toEqual(DEFAULT_TODO_CONFIG);
		writeFileSync(configFile, "[]");
		expect(readTodoConfig()).toEqual(DEFAULT_TODO_CONFIG);
	});

	test("non-boolean values are not coerced", () => {
		writeFileSync(configFile, JSON.stringify({ persistCollapsed: "yes", collapsed: 1 }));
		expect(readTodoConfig()).toEqual(DEFAULT_TODO_CONFIG);
	});

	test("writes merge, so turning persistence off keeps the remembered state", async () => {
		reset();
		await writeTodoConfig({ persistCollapsed: true, collapsed: true });
		await writeTodoConfig({ persistCollapsed: false });
		expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ persistCollapsed: false, collapsed: true });
	});
});

describe("overlay collapse persistence", () => {
	const fixture: TaskState = {
		tasks: [
			{ id: 1, subject: "Root", status: "pending" },
			{ id: 2, parentId: 1, subject: "Child", status: "in_progress" },
		] as Task[],
		nextId: 3,
	};

	function overlay(options: ConstructorParameters<typeof TodoOverlay>[0] = {}) {
		clearActiveRenderSession();
		setActiveRenderSession("config-test-session");
		commitState("config-test-session", structuredClone(fixture));
		return new TodoOverlay(options);
	}

	test("starts collapsed when told to, and reports changes upward", () => {
		const seen: boolean[] = [];
		const subject = overlay({ initialCollapsed: true, onCollapsedChange: (collapsed) => seen.push(collapsed) });
		expect(subject.isCollapsed()).toBe(true);
		subject.toggleCollapsed();
		expect(subject.isCollapsed()).toBe(false);
		expect(seen).toEqual([false]);
	});

	test("setting the same value twice does not report or notify a change", () => {
		const seen: boolean[] = [];
		const subject = overlay({ onCollapsedChange: (collapsed) => seen.push(collapsed) });
		subject.setCollapsed(false);
		expect(seen).toEqual([]);
		subject.setCollapsed(true);
		subject.setCollapsed(true);
		expect(seen).toEqual([true]);
	});
});

describe("/todos-persist-toggle", () => {
	function harness() {
		const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
		const shortcuts = new Map<string, Parameters<ExtensionAPI["registerShortcut"]>[1]>();
		const notifications: Array<{ message: string; type?: string }> = [];
		const extension = require("../src/index.ts").default as (pi: ExtensionAPI) => void;
		extension({
			registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
				commands.set(name, command),
			registerShortcut: (key: string, shortcut: Parameters<ExtensionAPI["registerShortcut"]>[1]) =>
				shortcuts.set(key, shortcut),
			registerTool: () => {},
			on: () => () => {},
			appendEntry: () => {},
		} as unknown as ExtensionAPI);
		const ctx = {
			mode: "print",
			hasUI: false,
			ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
			sessionManager: { getEntries: () => [], getBranch: () => [] },
		} as unknown as ExtensionCommandContext;
		return {
			run: (args = "") => commands.get("todos-persist-toggle")!.handler(args, ctx),
			async toggle() {
				await shortcuts.get("alt+t")!.handler(ctx as never);
				// The mouse path cannot await, so collapse writes are fire-and-forget.
				await flushTodoConfigWrites();
			},
			notifications,
			commands,
		};
	}

	test("bare invocation turns persistence on, then off again", async () => {
		reset();
		const app = harness();
		await app.run("");
		expect(readTodoConfig()).toEqual({ persistCollapsed: true, collapsed: false });
		expect(app.notifications.at(-1)?.message).toContain("remembered (expanded)");
		await app.run("");
		expect(readTodoConfig()).toEqual({ persistCollapsed: false, collapsed: false });
		expect(app.notifications.at(-1)?.message).toContain("no longer remembered");
	});

	test("on and off are idempotent", async () => {
		reset();
		const app = harness();
		await app.run("on");
		await app.run("on");
		expect(readTodoConfig().persistCollapsed).toBe(true);
		await app.run("off");
		await app.run("off");
		expect(readTodoConfig().persistCollapsed).toBe(false);
	});

	test("turning persistence off keeps the stored decision for later", async () => {
		reset();
		const app = harness();
		await app.run("on");
		await app.toggle(); // collapses the widget while persistence is on
		expect(readTodoConfig()).toEqual({ persistCollapsed: true, collapsed: true });
		await app.run("off");
		expect(readTodoConfig()).toEqual({ persistCollapsed: false, collapsed: true });
	});

	test("an unknown value is rejected without writing", async () => {
		reset();
		const app = harness();
		await app.run("maybe");
		expect(readTodoConfig()).toEqual(DEFAULT_TODO_CONFIG);
		expect(app.notifications.at(-1)?.type).toBe("warning");
	});

	test("the legacy `/todos persist` subcommand is gone", async () => {
		reset();
		const app = harness();
		const todos = (app.commands as Map<string, { description?: string }>).get("todos");
		expect(todos?.description).not.toContain("persist");
	});
});

describe("alt+t shortcut", () => {
	test("is registered and toggles the widget", () => {
		const shortcuts = new Map<string, Parameters<ExtensionAPI["registerShortcut"]>[1]>();
		require("../src/index.ts").default({
			registerCommand: () => {},
			registerShortcut: (key: string, shortcut: Parameters<ExtensionAPI["registerShortcut"]>[1]) =>
				shortcuts.set(key, shortcut),
			registerTool: () => {},
			on: () => () => {},
			appendEntry: () => {},
		} as unknown as ExtensionAPI);
		expect(shortcuts.has("alt+t")).toBe(true);
		expect(shortcuts.get("alt+t")!.description).toBe("Collapse or expand the todo widget");
	});

	test("does not claim a key pi or another extension already uses", () => {
		const shortcuts = new Map<string, unknown>();
		require("../src/index.ts").default({
			registerCommand: () => {},
			registerShortcut: (key: string) => shortcuts.set(key, {}),
			registerTool: () => {},
			on: () => () => {},
			appendEntry: () => {},
		} as unknown as ExtensionAPI);
		// Pi's documented defaults, plus the shortcuts sibling @arhen packages register.
		const taken = [
			"escape",
			"ctrl+c",
			"ctrl+d",
			"ctrl+z",
			"ctrl+g",
			"ctrl+v",
			"ctrl+p",
			"ctrl+s",
			"ctrl+n",
			"ctrl+r",
			"ctrl+l",
			"ctrl+t",
			"ctrl+o",
			"ctrl+x",
			"ctrl+a",
			"ctrl+b",
			"ctrl+e",
			"ctrl+f",
			"ctrl+j",
			"ctrl+k",
			"ctrl+q",
			"ctrl+u",
			"ctrl+w",
			"ctrl+y",
			"ctrl+backspace",
			"ctrl+shift+z",
			"ctrl+shift+a",
			"ctrl+shift+b",
			"ctrl+shift+j",
			"ctrl+shift+x",
			"alt+m",
			"alt+p",
			"alt+z",
			"alt+enter",
			"shift+tab",
			"shift+down",
		];
		for (const key of [...shortcuts.keys()]) expect(taken).not.toContain(key);
	});
});
