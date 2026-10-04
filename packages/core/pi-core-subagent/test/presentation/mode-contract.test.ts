import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { run as runFixture } from "../parity/fixtures.ts";
import {
	BASELINE_OPERATIONS,
	createExtensionHarness,
	type ExtensionHarness,
	requireTool,
	runTool,
} from "../parity/harness.ts";
import { callableTools, simulateLoadout } from "./loadout-sim.ts";

const SUBAGENT_TOOLS = [...BASELINE_OPERATIONS];
const MODE_ENTRY = "subagent-mode";

let h: ExtensionHarness;

beforeEach(() => {
	h = createExtensionHarness();
});
afterEach(async () => {
	await h.dispose();
});

async function cmd(args: string): Promise<void> {
	const command = h.commands.get("subagents");
	if (!command) throw new Error("the /subagents command is not registered");
	await command.handler(args, h.ctx());
}

async function mode(args = ""): Promise<string> {
	await cmd(args ? `mode ${args}` : "mode");
	return h.notifications.at(-1)?.message ?? "";
}

async function cmdWith(overrides: Record<string, unknown>, args: string): Promise<void> {
	const command = h.commands.get("subagents");
	if (!command) throw new Error("the /subagents command is not registered");
	await command.handler(args, h.ctx(overrides));
}

function exposureOf(name: string): string | undefined {
	return h.tools.get(name)?.exposure;
}

function expectDirectProfile(): void {
	for (const name of SUBAGENT_TOOLS) expect(exposureOf(name)).toBe("model-only");
	// No script path is available in this profile, so the namespace pointer must not be promised.
	expect(h.tools.get("subagent")?.description).not.toContain("describeNamespace");
	expect(h.tools.get("subagent_models")?.description).not.toContain("describeNamespace");
}

function expectCodemodeProfile(): void {
	// Only own tools that are really active are deferred (script-callable); a deactivated helper is
	// model-only so it stays out of scripts and declarations alike.
	const active = new Set(h.activeTools);
	for (const name of SUBAGENT_TOOLS) {
		expect(exposureOf(name)).toBe(active.has(name) ? "deferred" : "model-only");
		expect(h.tools.get(name)?.namespace?.name).toBe("subagents");
	}
	expect(h.tools.get("subagent")?.description).toContain("describeNamespace");
}

describe("mode preference and effective profile", () => {
	test("auto defaults to the model-only direct profile while codemode is inactive", async () => {
		h.activeTools.push("read", "bash", "subagent", "subagent_status", "await_subagent");
		await h.startSession();

		expectDirectProfile();
		const load = simulateLoadout(h);
		expect(load.hidden.size).toBe(0);
		expect(load.declared.map((tool) => tool.name)).toContain("subagent");
		expect(load.declared.map((tool) => tool.name)).toContain("subagent_status");
	});

	test("auto follows an active codemode into the deferred namespace profile", async () => {
		h.activeTools.push("read", "codemode", "subagent", "subagent_status");
		await h.startSession();

		expectCodemodeProfile();
		const load = simulateLoadout(h);
		expect([...load.hidden].sort()).toEqual(["subagent", "subagent_status"]);
		expect(load.declared.map((tool) => tool.name)).toEqual(["read", "codemode"]);
		const callable = load.callable.map((tool) => tool.name);
		// Only the active own tools stay script-callable; the rest are model-only and inactive.
		expect(callable).toContain("subagent");
		expect(callable).toContain("subagent_status");
		expect(callable).not.toContain("subagent_models");
		expect(callable).not.toContain("resume_subagent");

		const guidance = SUBAGENT_TOOLS.flatMap((name) => h.tools.get(name)?.promptGuidelines ?? []).join("\n");
		expect(guidance).toContain("describeTool('subagent')");
		expect(guidance).toContain("describeNamespace");
	});

	test("explicit direct stays model-only even with codemode active", async () => {
		h.activeTools.push("read", "codemode", "subagent");
		await h.startSession();
		await cmd("mode direct");

		expectDirectProfile();
		const load = simulateLoadout(h);
		expect(load.hidden.size).toBe(0);
		expect(load.declared.map((tool) => tool.name)).toContain("subagent");
		expect(h.appended.at(-1)).toEqual({ customType: MODE_ENTRY, data: { mode: "direct" } });
	});

	test("explicit codemode falls back to direct while codemode is inactive", async () => {
		h.activeTools.push("read", "subagent");
		await h.startSession();
		const report = await mode("codemode");

		expectDirectProfile();
		expect(report).toContain("effective direct");
		expect(report).toContain("codemode is not active");
		expect(h.appended.at(-1)).toEqual({ customType: MODE_ENTRY, data: { mode: "codemode" } });
	});

	test("bare /subagents mode reports preference, effective mode and availability", async () => {
		h.activeTools.push("read", "subagent");
		await h.startSession();
		const inactive = await mode();

		expect(inactive).toContain("mode auto");
		expect(inactive).toContain("effective direct");
		expect(inactive).toContain("codemode is not active");
		expect(inactive).toContain("/subagents mode auto|direct|codemode");

		h.activeTools.push("codemode");
		await h.invoke("before_agent_start", h.ctx());
		const active = await mode();
		expect(active).toContain("effective codemode");
	});
});

describe("persistence", () => {
	test("mode changes append a branch entry", async () => {
		h.activeTools.push("subagent");
		await h.startSession();

		await cmd("mode codemode");
		await cmd("mode auto");
		expect(h.appended).toEqual([
			{ customType: MODE_ENTRY, data: { mode: "codemode" } },
			{ customType: MODE_ENTRY, data: { mode: "auto" } },
		]);
	});

	test("session_start restores the latest preference on the branch", async () => {
		h.activeTools.push("codemode", "subagent");
		h.branch.push(
			{ type: "custom", customType: MODE_ENTRY, data: { mode: "codemode" } },
			{ type: "custom", customType: MODE_ENTRY, data: { mode: "direct" } },
		);
		await h.startSession();

		expectDirectProfile();
		expect(await mode()).toContain("mode direct");
	});

	test("a restored codemode preference applies once codemode is active", async () => {
		h.activeTools.push("codemode", "subagent");
		h.branch.push({ type: "custom", customType: MODE_ENTRY, data: { mode: "codemode" } });
		await h.startSession();

		expectCodemodeProfile();
		expect(await mode()).toContain("mode codemode");
	});

	test("tree navigation restores the preference of the new branch", async () => {
		h.activeTools.push("subagent");
		await h.startSession();
		await cmd("mode codemode");
		expect(await mode()).toContain("mode codemode");

		h.branch.length = 0;
		await h.invoke("session_tree", h.ctx());
		expect(await mode()).toContain("mode auto");
	});

	test("an unknown stored preference is ignored", async () => {
		h.activeTools.push("subagent");
		h.branch.push({ type: "custom", customType: MODE_ENTRY, data: { mode: "sideways" } });
		await h.startSession();

		expectDirectProfile();
		expect(await mode()).toContain("mode auto");
	});
});

describe("boundary refresh", () => {
	test("before_agent_start applies a codemode activation in auto mode", async () => {
		h.activeTools.push("read", "subagent");
		await h.startSession();
		expectDirectProfile();

		h.activeTools.push("codemode");
		await h.invoke("before_agent_start", h.ctx());
		expectCodemodeProfile();
	});

	test("before_agent_start returns to direct after codemode deactivation", async () => {
		h.activeTools.push("codemode", "read", "subagent");
		await h.startSession();
		expectCodemodeProfile();

		h.activeTools.splice(h.activeTools.indexOf("codemode"), 1);
		await h.invoke("before_agent_start", h.ctx());
		expectDirectProfile();
	});

	test("a codemode preference applies when codemode becomes active later", async () => {
		h.activeTools.push("subagent");
		await h.startSession();
		await cmd("mode codemode");
		expectDirectProfile();

		h.activeTools.push("codemode");
		await h.invoke("before_agent_start", h.ctx());
		expectCodemodeProfile();
	});

	test("a mode command while streaming defers the exposure change to the next boundary", async () => {
		h.activeTools.push("codemode", "read", "subagent");
		await h.startSession();
		expectCodemodeProfile();

		await cmdWith({ isIdle: () => false }, "mode direct");
		expect(exposureOf("subagent")).toBe("deferred");
		const pending = h.notifications.at(-1)?.message ?? "";
		expect(pending).toContain("next request boundary");
		expect(pending).toContain("mode direct");

		// The desired preference alone must not unhide the applied profile: while a live run still sees
		// deferred tools, a loadout recompute keeps the declarations hidden until sync applies direct.
		const load = simulateLoadout(h);
		expect([...load.hidden]).toEqual(["subagent"]);
		expect(load.callable.map((tool) => tool.name)).toContain("subagent");

		await h.invoke("before_agent_start", h.ctx());
		expectDirectProfile();
	});
});

describe("selection and state preservation", () => {
	test("switching modes preserves the active selection and unrelated names", async () => {
		h.activeTools.push("codemode", "read", "bash", "subagent", "subagent_status");
		await h.startSession();
		const before = [...h.activeTools];

		await cmd("mode codemode");
		expect(h.tools.get("subagent")?.exposure).toBe("deferred");
		expect(h.tools.get("subagent_status")?.exposure).toBe("deferred");
		expect(h.tools.get("subagent_models")?.exposure).toBe("model-only");
		expect(callableTools(h).map((tool) => tool.name)).not.toContain("subagent_models");

		await cmd("mode direct");
		expectDirectProfile();
		await cmd("mode auto");

		// Re-registration changes exposure only; the active selection is never rewritten.
		expect(h.activeTools).toEqual(before);
	});

	test("a native own-selection change re-registers at the next boundary", async () => {
		h.activeTools.push("codemode", "read", "subagent", "subagent_status");
		await h.startSession();
		expectCodemodeProfile();

		// Deactivate one helper while the overall mode stays codemode: its exposure must follow.
		h.activeTools.splice(h.activeTools.indexOf("subagent_status"), 1);
		await h.invoke("before_agent_start", h.ctx());
		expect(exposureOf("subagent_status")).toBe("model-only");
		expect(callableTools(h).map((tool) => tool.name)).not.toContain("subagent_status");
		expect(exposureOf("subagent")).toBe("deferred");

		// Reactivating it makes it script-callable again without a mode change.
		h.activeTools.push("subagent_status");
		await h.invoke("before_agent_start", h.ctx());
		expect(exposureOf("subagent_status")).toBe("deferred");
	});

	test("deactivated helpers stay model-only instead of becoming deferred", async () => {
		h.activeTools.push("codemode", "read", "subagent", "subagent_models");
		await h.startSession();

		for (const name of SUBAGENT_TOOLS)
			expect(exposureOf(name)).toBe(h.activeTools.includes(name) ? "deferred" : "model-only");
		// Inactive model-only helpers are neither declared nor callable.
		const load = simulateLoadout(h);
		expect(load.declared.map((tool) => tool.name)).not.toContain("subagent_status");
		expect(load.callable.map((tool) => tool.name)).not.toContain("subagent_status");
	});

	test("switching modes preserves existing manager runs", async () => {
		h.activeTools.push("read", "subagent");
		await h.startSession();
		const snapshot = runFixture({ id: "run_keep", status: "completed", tasks: [] });
		await h.restore([snapshot]);

		await cmd("mode codemode");
		const status = await runTool(h, "subagent_status", { runId: snapshot.id });
		expect(status.isError).not.toBe(true);
		expect(status.details?.run?.id).toBe(snapshot.id);
	});

	test("prepareLoadout hides only subagent declarations", async () => {
		h.activeTools.push("codemode", "read", "subagent", "subagent_cancel");
		await h.startSession();

		const load = simulateLoadout(h);
		expect([...load.hidden].sort()).toEqual(["subagent", "subagent_cancel"]);
		expect(load.declared.map((tool) => tool.name).sort()).toEqual(["codemode", "read"]);
		expect(load.callable.map((tool) => tool.name)).toContain("subagent");
	});
});

describe("context cleanup contract", () => {
	test("every subagent tool description is short", async () => {
		h.activeTools.push("subagent");
		await h.startSession();

		for (const name of SUBAGENT_TOOLS) {
			const tool = requireTool(h, name);
			expect(tool.description.length).toBeLessThan(400);
		}
	});

	test("the subagents namespace carries the long reference and the essentials stay upstream", async () => {
		h.activeTools.push("codemode", "subagent", "subagent_status", "resume_subagent");
		await h.startSession();

		const namespace = h.tools.get("subagent")?.namespace;
		expect(namespace?.name).toBe("subagents");
		expect(namespace?.instructions).toMatch(/describeTool/);
		expect(namespace?.instructions).toMatch(/subagent\(/);
		// Long signatures use the real object arguments, not positional prose.
		expect(namespace?.instructions).toContain("subagent_status({ runId })");
		expect(namespace?.instructions).toContain("resume_subagent({ runId, taskId, message?, model?, thinking? })");
		// Agent files match by description/goal and stay authoritative except for per-call tools/write.
		expect(namespace?.instructions).toMatch(/matched by `description` against the goal, never by name/i);
		expect(namespace?.instructions).toMatch(/only the per-call `tools` and `write` override them/i);

		const guidance = SUBAGENT_TOOLS.flatMap((name) => h.tools.get(name)?.promptGuidelines ?? []).join("\n");
		expect(guidance).toMatch(/read-only/i);
		expect(guidance).toMatch(/worktree/i);
		expect(guidance).toMatch(/subagent_status/);
		expect(guidance).toMatch(/resume_subagent/);
		expect(guidance).toMatch(/end your turn/i);
		expect(guidance).toMatch(/verify/i);
	});
});
