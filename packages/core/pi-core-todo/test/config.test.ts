import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createFakePi, isolateAgentDir } from "../../../../test-support/fake-pi.ts";
import { flushTodoConfigWrites, readTodoConfig, TODO_CONFIG_FILENAME, writeTodoConfig } from "../src/config.ts";
import extension from "../src/index.ts";
import { TodoOverlay } from "../src/overlay.ts";
import { clearActiveRenderSession } from "../src/store.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousCacheHome = process.env.XDG_CACHE_HOME;
const { root, agentDir } = isolateAgentDir("todo-config");
mkdirSync(agentDir, { recursive: true });
const configFile = join(agentDir, TODO_CONFIG_FILENAME);

function reset() {
	rmSync(configFile, { recursive: true, force: true });
	clearActiveRenderSession();
}

afterAll(async () => {
	await flushTodoConfigWrites();
	clearActiveRenderSession();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = previousCacheHome;
	rmSync(root, { recursive: true, force: true });
});

describe("todo config file", () => {
	test("missing, malformed and non-boolean values default to expanded", () => {
		reset();
		expect(readTodoConfig()).toEqual({ collapsed: false });
		for (const raw of ["{ nope", "null", "[]", "true", '{"collapsed":"true"}', '{"collapsed":1}']) {
			writeFileSync(configFile, raw);
			expect(readTodoConfig()).toEqual({ collapsed: false });
		}
	});

	test("stores just the collapsed boolean, creating the directory if needed", async () => {
		const path = join(root, "new-agent", TODO_CONFIG_FILENAME);
		await writeTodoConfig({ collapsed: true }, path);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ collapsed: true });
		await writeTodoConfig({ collapsed: false }, path);
		expect(readTodoConfig(path)).toEqual({ collapsed: false });
		expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
	});

	test("queued toggles preserve the last decision and flush waits for it", async () => {
		reset();
		const writes = [true, false, true].map((collapsed) => writeTodoConfig({ collapsed }));
		await flushTodoConfigWrites();
		await Promise.all(writes);
		expect(readTodoConfig()).toEqual({ collapsed: true });
	});

	test("a failed atomic replacement preserves existing data and does not poison the queue", async () => {
		reset();
		mkdirSync(configFile);
		const sentinel = join(configFile, "keep");
		writeFileSync(sentinel, "unchanged");
		await expect(writeTodoConfig({ collapsed: true })).rejects.toThrow();
		expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
		expect(existsSync(`${configFile}.${process.pid}.tmp`)).toBe(false);
		reset();
		await writeTodoConfig({ collapsed: true });
		expect(readTodoConfig()).toEqual({ collapsed: true });
	});
});

describe("overlay collapse changes", () => {
	test("restores the initial state and reports only changed decisions", () => {
		const seen: boolean[] = [];
		const overlay = new TodoOverlay({ initialCollapsed: true, onCollapsedChange: (value) => seen.push(value) });
		expect(overlay.isCollapsed()).toBe(true);
		overlay.setCollapsed(true);
		overlay.toggleCollapsed();
		overlay.setCollapsed(false);
		expect(overlay.isCollapsed()).toBe(false);
		expect(seen).toEqual([false]);
	});
});

describe("widget preferences", () => {
	function harness() {
		const app = createFakePi();
		const notifications: Array<{ message: string; type?: string }> = [];
		let browserOpens = 0;
		extension(app.api);
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				notify: (message: string, type?: string) => notifications.push({ message, type }),
				setWidget: () => {},
				custom: async () => {
					browserOpens++;
				},
			},
			sessionManager: { getSessionId: () => "config-test", getEntries: () => [], getBranch: () => [] },
		} as unknown as ExtensionCommandContext;
		return {
			...app,
			ctx,
			notifications,
			get browserOpens() {
				return browserOpens;
			},
			run: (args = "") => app.run("todos", args, ctx),
			toggle: () => app.shortcuts.get("alt+t")!.handler(ctx),
		};
	}

	test("collapse/expand/toggle are always remembered; bare /todos still browses", async () => {
		reset();
		const app = harness();
		expect([...app.commands.keys()]).toEqual(["todos"]);
		await app.run("collapse");
		await flushTodoConfigWrites();
		expect(readTodoConfig()).toEqual({ collapsed: true });
		await app.run("expand");
		await flushTodoConfigWrites();
		expect(readTodoConfig()).toEqual({ collapsed: false });
		await app.run("toggle");
		await flushTodoConfigWrites();
		expect(readTodoConfig()).toEqual({ collapsed: true });
		await app.run();
		expect(app.browserOpens).toBe(1);
	});

	test("reload restores the saved state; keyboard changes are drained on shutdown", async () => {
		reset();
		await writeTodoConfig({ collapsed: true });
		const app = harness();
		await app.toggle();
		await app.emit("session_shutdown", {}, app.ctx);
		expect(readTodoConfig()).toEqual({ collapsed: false });
		expect(app.shortcuts.get("alt+t")?.description).toBe("Collapse or expand the todo widget");
	});

	test("unknown subcommands warn without changing the preference or opening the browser", async () => {
		reset();
		const app = harness();
		await app.run("unknown");
		expect(app.notifications.at(-1)?.type).toBe("warning");
		expect(existsSync(configFile)).toBe(false);
		expect(app.browserOpens).toBe(0);
	});

	test("a failed background save warns instead of rejecting unhandled", async () => {
		reset();
		const app = harness();
		await app.emit("session_start", {}, app.ctx);
		mkdirSync(configFile);
		await app.run("collapse");
		await flushTodoConfigWrites();
		expect(app.notifications.at(-1)?.type).toBe("warning");
		expect(app.notifications.at(-1)?.message).toContain("Could not save");
		reset();
	});
});
