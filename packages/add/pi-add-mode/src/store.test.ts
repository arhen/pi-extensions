import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModeStore } from "./store.ts";

let root: string;
let globalPath: string;
let projectPath: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-add-mode-"));
	globalPath = join(root, "agent", "modes.json");
	projectPath = join(root, "project", ".pi", "modes.json");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2));
}

function readJson(path: string): Record<string, any> {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function newStore(): ModeStore {
	const store = new ModeStore(root, { globalPath, projectPath });
	store.load();
	return store;
}

describe("ModeStore", () => {
	test("project overrides global entries by name", () => {
		writeJson(globalPath, {
			review: { tools: "plan" },
			globalOnly: { enabled: false },
		});
		writeJson(projectPath, {
			review: { tools: "build", model: "p/m" },
			projectOnly: {},
		});

		const store = newStore();
		expect(store.names()).toEqual(["globalOnly", "projectOnly", "review"]);
		expect(store.get("review")?.tools).toBe("build");
		expect(store.get("review")?.model).toBe("p/m");
		expect(store.get("globalOnly")?.enabled).toBe(false);
		expect(store.get("projectOnly")?.enabled).toBe(true);
	});

	test("reserved default name is ignored", () => {
		writeJson(globalPath, { default: { tools: "plan" } });
		expect(newStore().get("default")).toBeUndefined();
	});

	test("save keeps global and project origins apart", () => {
		writeJson(globalPath, { globalMode: { tools: "plan" } });
		writeJson(projectPath, { projectMode: { tools: "build" } });

		const store = newStore();
		const projectMode = store.get("projectMode");
		if (!projectMode) throw new Error("projectMode missing");
		projectMode.color = "#ff9f43";
		store.upsert(projectMode);
		store.upsert({ name: "fresh", enabled: true, tools: "default" });
		store.save();

		expect(readJson(globalPath)).toEqual({
			globalMode: { enabled: true, tools: "plan" },
			fresh: { enabled: true, tools: "default" },
		});
		expect(readJson(projectPath)).toEqual({
			projectMode: { enabled: true, tools: "build", color: "#ff9f43" },
		});
	});

	test("rename preserves origin and payload", () => {
		writeJson(projectPath, { old: { tools: "plan", instructions: "x" } });
		const store = newStore();
		store.rename("old", "new");
		store.save();

		expect(readJson(projectPath)).toEqual({ new: { enabled: true, tools: "plan", instructions: "x" } });
		expect(readJson(globalPath)).toEqual({});
	});

	test("round-trips through disk", () => {
		const store = newStore();
		store.upsert({
			name: "review",
			enabled: false,
			tools: ["read", "bash"],
			color: "accent",
			thinking: "xhigh",
			subagentModel: "p/s",
			subagentThinking: "low",
		});
		store.save();

		const reloaded = newStore();
		expect(reloaded.get("review")).toEqual({
			name: "review",
			enabled: false,
			tools: ["read", "bash"],
			color: "accent",
			thinking: "xhigh",
			subagentModel: "p/s",
			subagentThinking: "low",
			description: undefined,
			instructions: undefined,
			model: undefined,
		});
	});

	test("remove deletes an entry", () => {
		writeJson(globalPath, { a: {}, b: {} });
		const store = newStore();
		store.remove("a");
		store.save();
		expect(Object.keys(readJson(globalPath))).toEqual(["b"]);
	});
});
