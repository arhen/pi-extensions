import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionToolContext,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isolateAgentDir } from "../../../../test-support/fake-pi.ts";
import extension from "../src/index.ts";
import { commitState, getState, restoreSession, STATE_TYPE } from "../src/store.ts";
import type { TaskDetails, TaskState, TodoParamsSchema } from "../src/types.ts";

type TodoTool = ToolDefinition<typeof TodoParamsSchema, TaskDetails, { label?: string }>;
type Params = Parameters<TodoTool["execute"]>[1];

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousCacheHome = process.env.XDG_CACHE_HOME;
const { root, agentDir } = isolateAgentDir("todo-persistence");
mkdirSync(agentDir, { recursive: true });
const legacyFile = join(agentDir, "pi-todo-state.json");
const original: TaskState = {
	tasks: [
		{ id: 1, subject: "Parent", status: "pending" },
		{ id: 2, parentId: 1, subject: "Child", status: "completed", metadata: { note: "saved" } },
		{ id: 3, parentId: 1, subject: "Next", status: "in_progress", activeForm: "checking", blockedBy: [2] },
		{ id: 4, subject: "Cancelled", status: "deleted" },
	],
	nextId: 5,
};

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = previousCacheHome;
	rmSync(root, { recursive: true, force: true });
});

function manager(persist = true): SessionManager {
	const session = persist ? SessionManager.create(root, join(root, "sessions")) : SessionManager.inMemory(root);
	session.appendMessage({ role: "user", content: "Work", timestamp: Date.now() });
	return session;
}

function harness(session: SessionManager, failPersist = false) {
	let tool: TodoTool | undefined;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionToolContext) => unknown>();
	const ctx = { sessionManager: session, mode: "print", hasUI: false } as unknown as ExtensionToolContext;
	extension({
		registerTool: (value: TodoTool) => {
			tool = value;
		},
		registerCommand: () => {},
		appendEntry: (type: string, data: unknown) => {
			if (failPersist) throw new Error("disk unavailable");
			session.appendCustomEntry(type, data);
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionToolContext) => unknown) => {
			handlers.set(event, handler);
			return () => {};
		},
	} as unknown as ExtensionAPI);
	return {
		async emit(event: string) {
			await handlers.get(event)?.({}, ctx);
		},
		async execute(params: Params) {
			return tool!.execute("todo-call", params, undefined, undefined, ctx);
		},
	};
}

function appendToolSnapshot(session: SessionManager, action: TaskDetails["action"], state: TaskState, error?: string) {
	session.appendMessage({
		role: "toolResult",
		toolCallId: "old-todo",
		toolName: "todo",
		content: [{ type: "text", text: error ?? action }],
		details: { action, params: {}, ...structuredClone(state), ...(error ? { error } : {}) } as unknown as JsonValue,
		isError: !!error,
		timestamp: Date.now(),
	});
}

function snapshots(session: SessionManager) {
	return session.getBranch().filter((entry) => entry.type === "custom" && entry.customType === STATE_TYPE);
}

describe("session-log persistence", () => {
	test("nested tool mutations persist before returning, without a tool-result transcript entry", async () => {
		const session = manager();
		const app = harness(session);
		await app.emit("session_start");
		await app.execute({
			action: "batch",
			ops: [
				{ action: "create", ref: "parent", subject: "Parent" },
				{ action: "create", subject: "Child", parentId: "parent", status: "in_progress", activeForm: "working" },
			],
		});
		expect(snapshots(session)).toHaveLength(1);
		expect(session.getBranch().some((entry) => entry.type === "message" && entry.message.role === "toolResult")).toBe(
			false,
		);
		const file = session.getSessionFile()!;
		expect(readFileSync(file, "utf8")).toContain(STATE_TYPE);
		const processRestore = Bun.spawnSync([
			process.execPath,
			"--eval",
			`import { SessionManager } from "@earendil-works/pi-coding-agent";
			import { getState, restoreSession } from ${JSON.stringify(join(import.meta.dir, "../src/store.ts"))};
			const session = SessionManager.open(${JSON.stringify(file)});
			restoreSession(session.getSessionId(), session.getBranch());
			console.log(JSON.stringify(getState(session.getSessionId())));`,
		]);
		expect(processRestore.exitCode).toBe(0);
		expect(JSON.parse(processRestore.stdout.toString()).tasks[1].parentId).toBe(1);
		const reopened = SessionManager.open(file);
		commitState(reopened.getSessionId(), { tasks: [], nextId: 1 });
		const restored = harness(reopened);
		await restored.emit("session_start");
		const result = await restored.execute({ action: "list" });
		expect(result.details.tasks.map((task) => task.subject)).toEqual(["Parent", "Child"]);
		expect(result.details.tasks[1]).toMatchObject({ parentId: 1, status: "in_progress", activeForm: "working" });
		const next = await restored.execute({ action: "create", subject: "Next" });
		expect(next.details.nextId).toBe(4);
	});

	test("concurrent sessions cannot overwrite one another or the legacy sidecar", async () => {
		const first = manager();
		const second = manager();
		writeFileSync(legacyFile, JSON.stringify({ [first.getSessionId()]: original }));
		const before = readFileSync(legacyFile, "utf8");
		const a = harness(first);
		const b = harness(second);
		await a.emit("session_start");
		await b.emit("session_start");
		await a.execute({ action: "create", subject: "First process" });
		await b.execute({ action: "create", subject: "Second process" });
		expect(readFileSync(legacyFile, "utf8")).toBe(before);
		for (const [session, subject] of [
			[first, "First process"],
			[second, "Second process"],
		] as const) {
			const reopened = SessionManager.open(session.getSessionFile()!);
			const app = harness(reopened);
			await app.emit("session_start");
			const result = await app.execute({ action: "list" });
			expect(result.details.tasks.at(-1)?.subject).toBe(subject);
		}
	});

	test("compaction preserves state even when model context contains no todo history", async () => {
		const session = manager();
		const app = harness(session);
		await app.emit("session_start");
		await app.execute({ action: "create", subject: "Survives compaction" });
		session.appendCompaction("Work remains", null, 1000);
		expect(session.buildSessionContext().messages.some((message) => message.role === "toolResult")).toBe(false);
		const reopened = SessionManager.open(session.getSessionFile()!);
		const restored = harness(reopened);
		await restored.emit("session_start");
		expect((await restored.execute({ action: "list" })).details.tasks[0]?.subject).toBe("Survives compaction");
	});

	test("tree navigation restores branch state, without importing future legacy state", async () => {
		const session = manager();
		const emptyLeaf = session.getLeafId()!;
		const app = harness(session);
		await app.emit("session_start");
		await app.execute({ action: "create", subject: "First branch" });
		const firstLeaf = session.getLeafId()!;
		await app.execute({ action: "create", subject: "Later task" });
		session.branch(firstLeaf);
		await app.emit("session_tree");
		expect((await app.execute({ action: "list" })).details.tasks.map((task) => task.subject)).toEqual(["First branch"]);
		writeFileSync(legacyFile, JSON.stringify({ [session.getSessionId()]: original }));
		session.branch(emptyLeaf);
		await app.emit("session_tree");
		expect((await app.execute({ action: "list" })).details.tasks).toEqual([]);
		const reloaded = harness(session);
		await reloaded.emit("session_start");
		expect((await reloaded.execute({ action: "list" })).details.tasks).toEqual([]);
	});

	test("copied branches inherit snapshots but new sessions stay empty", async () => {
		const source = manager(false);
		source.appendCustomEntry(STATE_TYPE, original);
		const clone = SessionManager.inMemory(root, undefined, [source.getHeader()!, ...source.getBranch()]);
		clone.appendCustomEntry("unrelated", {});
		expect(restoreSession("cloned-session", clone.getBranch())).toBe(true);
		expect(getState("cloned-session")).toEqual(original);
		const fresh = manager(false);
		expect(restoreSession(fresh.getSessionId(), fresh.getBranch())).toBe(false);
		expect(getState(fresh.getSessionId())).toEqual({ tasks: [], nextId: 1 });
	});

	test("clear persists an empty snapshot and resets IDs after reload", async () => {
		const session = manager();
		session.appendCustomEntry(STATE_TYPE, original);
		const app = harness(session);
		await app.emit("session_start");
		await app.execute({ action: "clear" });
		const restored = harness(SessionManager.open(session.getSessionFile()!));
		await restored.emit("session_start");
		expect((await restored.execute({ action: "list" })).details.tasks).toEqual([]);
		expect((await restored.execute({ action: "create", subject: "Restart IDs" })).details.tasks[0]?.id).toBe(1);
	});

	test("read-only and failed mutations never append a snapshot", async () => {
		const session = manager();
		const app = harness(session);
		await app.emit("session_start");
		await app.execute({ action: "create", subject: "Keep" });
		const count = snapshots(session).length;
		await app.execute({ action: "list" });
		await app.execute({ action: "get", id: 1 });
		const failed = await app.execute({ action: "batch", ops: [{ action: "update", id: 99, status: "completed" }] });
		expect(failed.isError).toBe(true);
		expect(snapshots(session)).toHaveLength(count);
	});

	test("write errors fail the tool without committing in-memory changes", async () => {
		const session = manager();
		const app = harness(session, true);
		await app.emit("session_start");
		await expect(app.execute({ action: "create", subject: "Not saved" })).rejects.toThrow("disk unavailable");
		expect(getState(session.getSessionId())).toEqual({ tasks: [], nextId: 1 });
	});

	test("no-session runs keep snapshots in memory without external writes", async () => {
		const session = manager(false);
		const app = harness(session);
		await app.emit("session_start");
		await app.execute({ action: "create", subject: "Ephemeral" });
		expect(snapshots(session)).toHaveLength(1);
		expect(session.getSessionFile()).toBeUndefined();
	});
});

describe("legacy recovery", () => {
	test("recover earlier tasks after an empty error and list, ignoring the corrupted sidecar", async () => {
		const session = manager();
		appendToolSnapshot(session, "batch", original);
		appendToolSnapshot(session, "batch", { tasks: [], nextId: 1 }, "parentId: #31 not found");
		appendToolSnapshot(session, "list", { tasks: [], nextId: 1 });
		writeFileSync(legacyFile, "invalid json");
		const app = harness(session);
		await app.emit("session_start");
		expect(getState(session.getSessionId())).toEqual(original);
		expect(snapshots(session)).toHaveLength(1);
	});

	test("migrate a legacy sidecar once, preserving metadata, dependencies, and tombstones", async () => {
		const session = manager();
		writeFileSync(legacyFile, JSON.stringify({ [session.getSessionId()]: original }));
		const app = harness(session);
		await app.emit("session_start");
		expect(getState(session.getSessionId())).toEqual(original);
		rmSync(legacyFile);
		const restored = harness(SessionManager.open(session.getSessionFile()!));
		await restored.emit("session_start");
		expect(getState(session.getSessionId())).toEqual(original);
	});

	test("recovery also works when the tool runs before session_start", async () => {
		const session = manager();
		appendToolSnapshot(session, "create", original);
		const app = harness(session);
		expect((await app.execute({ action: "list" })).details.tasks).toEqual(original.tasks);
	});

	test("malformed snapshots are skipped and stale nextId never reuses an ID", () => {
		const session = manager(false);
		session.appendCustomEntry(STATE_TYPE, { ...original, nextId: 1 });
		session.appendCustomEntry(STATE_TYPE, { tasks: [null], nextId: 2 });
		expect(restoreSession(session.getSessionId(), session.getBranch())).toBe(true);
		expect(getState(session.getSessionId())).toEqual(original);
	});

	test("restored state does not mutate the persisted snapshot", () => {
		const session = manager(false);
		const saved = structuredClone(original);
		session.appendCustomEntry(STATE_TYPE, saved);
		restoreSession(session.getSessionId(), session.getBranch());
		getState(session.getSessionId()).tasks[1]!.metadata!.note = "changed";
		expect(saved.tasks[1]!.metadata!.note).toBe("saved");
	});
});
