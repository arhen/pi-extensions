import test from "node:test";
import assert from "node:assert/strict";
import { splitCmd, splitFileCmd } from "./index.ts";

test("plain command stays argv-direct", () => {
	assert.deepEqual(splitCmd("tsc --noEmit"), ["tsc", ["--noEmit"]]);
});
test("&& chain wraps in bash -lc (the EINVALIDTAGNAME regression)", () => {
	assert.deepEqual(splitCmd("npm install && npm run check"), ["bash", ["-lc", "npm install && npm run check"]]);
});
test("pipes and redirects wrap too", () => {
	assert.deepEqual(splitCmd("grep foo src | head"), ["bash", ["-lc", "grep foo src | head"]]);
	assert.deepEqual(splitCmd("bun t > out.log"), ["bash", ["-lc", "bun t > out.log"]]);
});
test("empty input yields empty command", () => {
	assert.deepEqual(splitCmd("   "), ["", []]);
});
test("fileCheck substitutes ${file} and still wraps shell chains", () => {
	assert.deepEqual(
		splitFileCmd("npx biome check --formatter-enabled=false ${file}", "a b.ts"),
		["npx", ["biome", "check", "--formatter-enabled=false", "a b.ts"]],
	);
	assert.deepEqual(
		splitFileCmd("cd pkg && lint ${file}", "src/a.ts"),
		["bash", ["-lc", "cd pkg && lint src/a.ts"]],
	);
});