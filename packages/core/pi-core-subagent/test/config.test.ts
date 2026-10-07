import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStoredMode, readSubagentConfig, writeSubagentConfig } from "../src/config.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "subagent-config-"));
	dirs.push(dir);
	return join(dir, "subagents-config.json");
}

describe("readSubagentConfig", () => {
	test("a missing file degrades to an empty object", () => {
		expect(readSubagentConfig(configFile())).toEqual({});
	});

	test("malformed JSON and non-object roots degrade to an empty object", () => {
		const path = configFile();
		writeFileSync(path, "{ nope");
		expect(readSubagentConfig(path)).toEqual({});
		writeFileSync(path, "[]");
		expect(readSubagentConfig(path)).toEqual({});
	});
});

describe("readStoredMode", () => {
	test("returns a known mode and ignores an unknown one", () => {
		const path = configFile();
		writeFileSync(path, JSON.stringify({ mode: "codemode" }));
		expect(readStoredMode(path)).toBe("codemode");
		writeFileSync(path, JSON.stringify({ mode: "sideways" }));
		expect(readStoredMode(path)).toBeUndefined();
	});
});

describe("writeSubagentConfig", () => {
	test("merges keys instead of clobbering the file", async () => {
		const path = configFile();
		await writeSubagentConfig({ autoLimit: true }, path);
		await writeSubagentConfig({ mode: "auto" }, path);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ autoLimit: true, mode: "auto" });
	});

	test("concurrent writers of different keys both survive", async () => {
		const path = configFile();
		await Promise.all([
			writeSubagentConfig({ autoLimit: true }, path),
			writeSubagentConfig({ mode: "codemode" }, path),
		]);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ autoLimit: true, mode: "codemode" });
	});
});
