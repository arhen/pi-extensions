import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { run as runFixture } from "../parity/fixtures.ts";
import {
	BASELINE_OPERATIONS,
	createExtensionHarness,
	type ExtensionHarness,
	requireTool,
	runTool,
} from "../parity/harness.ts";
import { simulateLoadout } from "./loadout-sim.ts";

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

function exposureOf(name: string): string | undefined {
	return h.tools.get(name)?.exposure;
}

function expectDirectProfile(): void {
	for (const name of SUBAGENT_TOOLS) expect(exposureOf(name)).toBe("model-only");
}

function expectCodemodeProfile(): void {
	for (const name of SUBAGENT_TOOLS) {
		expect(exposureOf(name)).toBe("deferred");
		expect(h.tools.get(name)?.namespace?.name).toBe("subagents");
	}
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
		for (const name of SUBAGENT_TOOLS) expect(load.callable.map((tool) => tool.name)).toContain(name);

		const guidance = SUBAGENT_TOOLS.flatMap((name) => h.tools.get(name)?.promptGuidelines ?? []).join("\n");
		expect(guidance).toContain("searchTools");
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
});

describe("selection and state preservation", () => {
	test("switching modes never rewrites the active tool selection", async () => {
		h.activeTools.push("read", "bash", "subagent", "subagent_status");
		await h.startSession();

		await cmd("mode codemode");
		await cmd("mode direct");
		await cmd("mode auto");

		for (const call of h.setActiveCalls) {
			for (const unrelated of ["read", "bash"]) expect(call).toContain(unrelated);
		}
		expect(h.activeTools).toContain("read");
		expect(h.activeTools).toContain("bash");
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
		expect(namespace?.instructions).toMatch(/describeNamespace/);
		expect(namespace?.instructions).toMatch(/subagent\(/);

		const guidance = SUBAGENT_TOOLS.flatMap((name) => h.tools.get(name)?.promptGuidelines ?? []).join("\n");
		expect(guidance).toMatch(/read-only/i);
		expect(guidance).toMatch(/worktree/i);
		expect(guidance).toMatch(/subagent_status/);
		expect(guidance).toMatch(/resume_subagent/);
		expect(guidance).toMatch(/end your turn/i);
		expect(guidance).toMatch(/verify/i);
	});
});
