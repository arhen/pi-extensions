import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { resolveOptions } from "../bench/lib/args.ts";
import { DELEGATE_ARGUMENTS, matchesControlledArguments } from "../bench/lib/contract.ts";
import { Probe } from "../bench/lib/probe.ts";
import { applyPresentationCommands } from "../bench/lib/samples.ts";
import { type BuiltSession, planCodemode } from "../bench/lib/session.ts";

function fixture(mode: string, commands = ["subagents"], disposition = "handled") {
	const calls: string[] = [];
	const built = {
		session: {
			prompt: async (text: string, options: { preflightResult: (value: string) => void }) => {
				calls.push(text);
				options.preflightResult(disposition);
			},
		} as unknown as AgentSession,
		extensions: [{ commands }],
	} as unknown as BuiltSession;
	const opts = resolveOptions(["--dry-run", "--mode", mode]);
	if (!opts) throw new Error("Invalid benchmark fixture options");
	return { built, opts, calls, probe: new Probe(performance.now()), errors: [] as string[] };
}

describe("benchmark controls", () => {
	test("removing the last modifier preserves default tools instead of selecting none", () => {
		expect(planCodemode("disabled", ["+codemode"]).defaultTools).toBeUndefined();
		expect(planCodemode("disabled", []).defaultTools).toEqual([]);
		expect(planCodemode("disabled", ["read", "codemode"]).defaultTools).toEqual(["read"]);
	});

	test("controlled child arguments match independently of property ordering", () => {
		const reordered = { notifyPerTask: true, autoAwait: true, tasks: DELEGATE_ARGUMENTS.tasks };
		expect(matchesControlledArguments(JSON.stringify(reordered))).toBe(true);
	});

	test("uncontrolled child tools, prompts or truncated arguments cannot enter comparisons", () => {
		const changed = structuredClone(DELEGATE_ARGUMENTS);
		changed.tasks[0]!.tools.push("read");
		expect(matchesControlledArguments(JSON.stringify(changed))).toBe(false);
		expect(matchesControlledArguments('{"tasks": …')).toBe(false);
	});
});

describe("benchmark presentation preflight", () => {
	test("baseline never invokes a nonexistent mode subcommand", async () => {
		const f = fixture("baseline");
		const result = await applyPresentationCommands(f.built, f.probe, f.opts, f.errors);
		expect(f.calls).toEqual([]);
		expect(result.modeCommand).toBeUndefined();
	});

	for (const mode of ["direct", "codemode", "auto"]) {
		test(`${mode} is applied before either measured workflow`, async () => {
			const f = fixture(mode);
			const result = await applyPresentationCommands(f.built, f.probe, f.opts, f.errors);
			expect(f.calls).toEqual([`/subagents mode ${mode}`]);
			expect(result.modeCommand?.preflight).toBe("handled");
			expect(result.modeCommand?.modelCalls).toBe(0);
			expect(f.errors).toEqual([]);
		});
	}

	test("a missing command fails before a measured model call", async () => {
		const f = fixture("direct", []);
		await expect(applyPresentationCommands(f.built, f.probe, f.opts, f.errors)).rejects.toThrow(
			/command not registered/,
		);
		expect(f.calls).toEqual([]);
	});

	test("an unhandled mode command cannot silently benchmark the default mode", async () => {
		const f = fixture("direct", ["subagents"], "started");
		await expect(applyPresentationCommands(f.built, f.probe, f.opts, f.errors)).rejects.toThrow(
			/command was not handled/,
		);
	});
});
