import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeSubagentConfig } from "../../src/config.ts";
import { BASELINE_OPERATIONS } from "../parity/harness.ts";
import { isolateAgentDir } from "./agent-dir.ts";
import {
	captureTextRequest,
	createRuntimeHarness,
	declaredTools,
	lastCodemodeResult,
	type RuntimeHarness,
} from "./runtime-harness.ts";

const SUBAGENT_TOOLS = [...BASELINE_OPERATIONS];

const cleanups: (() => void)[] = [];
const agentDir = isolateAgentDir();
beforeEach(() => agentDir.reset());
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
afterAll(() => agentDir.restore());

async function harness(options: Parameters<typeof createRuntimeHarness>[0] = {}): Promise<RuntimeHarness> {
	const created = await createRuntimeHarness(options);
	cleanups.push(created.cleanup);
	return created;
}

function exposures(h: RuntimeHarness): string[] {
	return h.session
		.getAllTools()
		.filter((tool) => (SUBAGENT_TOOLS as readonly string[]).includes(tool.name))
		.map((tool) => tool.exposure);
}

const DISCOVERY_SCRIPT = `
const found = await searchTools("subagent", { limit: 12 });
const ns = await describeNamespace("subagents");
let validation = null;
try {
  await tools.subagent_status({});
} catch (error) {
  validation = String(error && error.message ? error.message : error);
}
return {
  names: found.map((entry) => entry.name).sort(),
  hasInstructions: !!(ns && ns.instructions),
  validation,
};
`;

describe("native exposure modes at runtime", () => {
	test("the default without codemode declares legacy direct subagent tools", async () => {
		const h = await harness({ codemode: false });
		expect(exposures(h)).toEqual(SUBAGENT_TOOLS.map(() => "direct"));
		expect(h.session.getActiveToolNames()).toContain("subagent");

		const context = await captureTextRequest(h, "hello");
		const names = declaredTools(context).map((tool) => tool.name);
		expect(names).toContain("subagent");
		expect(names).toContain("subagent_status");
		expect(names).not.toContain("codemode");
	}, 60_000);

	test("auto with codemode on keeps deferred tools out of declarations and the catalog", async () => {
		const h = await harness({ codemode: "on", inlineBudget: 3000 });
		await h.session.prompt("/subagents mode auto");
		expect(exposures(h)).toEqual(SUBAGENT_TOOLS.map(() => "deferred"));
		// Retained active selection: all nine stay active but their declarations are hidden.
		const active = new Set(h.session.getActiveToolNames());
		for (const name of SUBAGENT_TOOLS) expect(active.has(name)).toBe(true);

		const context = await captureTextRequest(h, "hello");
		const declarations = declaredTools(context);
		const names = declarations.map((tool) => tool.name);
		for (const name of SUBAGENT_TOOLS) expect(names).not.toContain(name);

		const codemode = declarations.find((tool) => tool.name === "codemode");
		expect(codemode).toBeDefined();
		expect(codemode?.description).not.toContain("subagent_status");
		expect(codemode?.description).not.toContain("runId");

		expect(h.session.systemPrompt).not.toContain("Define and delegate");
		expect(h.session.systemPrompt).not.toContain("Check progress of a subagent run");
		// Guardrail guidelines survive hidden declarations.
		expect(h.session.systemPrompt).toContain("read-only by default");
	}, 60_000);

	test("codemode discovery, namespace instructions and nested validation run in the real sandbox", async () => {
		const h = await harness({ codemode: "on" });
		await h.session.prompt("/subagents mode codemode");
		const requests: TranscriptContext[] = [];
		h.faux.setResponses([
			(context) => {
				requests.push(context);
				return fauxAssistantMessage([fauxToolCall("codemode", { code: DISCOVERY_SCRIPT })]);
			},
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("discover and validate subagents");
		expect(requests).toHaveLength(1);

		const result = lastCodemodeResult(h.session);
		expect(result).toContain("Script completed");
		expect(result).toContain("subagent_status");
		expect(result).toContain('"hasInstructions":true');
		expect(result).toMatch(/runId/);
	}, 60_000);

	test("legacy direct respects an explicit global codemode.mode=only policy", async () => {
		const h = await harness({ codemode: "only", inlineBudget: 3000 });
		await h.session.prompt("/subagents mode direct");

		const context = await captureTextRequest(h, "hello");
		const declarations = declaredTools(context);
		const names = declarations.map((tool) => tool.name);
		expect(names).not.toContain("subagent");
		expect(names).not.toContain("subagent_status");
		expect(names).not.toContain("read");
		expect(h.session.getCallableToolNames()).toContain("subagent");
		expect(names).toContain("codemode");

		expect(h.session.systemPrompt).not.toContain("Define and delegate");
		expect(h.session.systemPrompt).not.toContain("Read file contents");
	}, 60_000);

	test("global codemode.mode=only with the codemode profile inlines no subagent schema", async () => {
		const h = await harness({ codemode: "only", inlineBudget: 3000 });
		await h.session.prompt("/subagents mode codemode");

		const context = await captureTextRequest(h, "hello");
		const declarations = declaredTools(context);
		const names = declarations.map((tool) => tool.name);
		for (const name of SUBAGENT_TOOLS) expect(names).not.toContain(name);

		const codemode = declarations.find((tool) => tool.name === "codemode");
		expect(codemode?.description).not.toContain("subagent_status");
		expect(codemode?.description).not.toContain("runId");
		expect(h.session.systemPrompt).not.toContain("Define and delegate");
	}, 60_000);

	test("a globally stored preference drives a reopened session and outranks its branch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-resume-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const sessionDir = join(dir, "sessions");

		const first = await harness({ codemode: "on", dir, sessionManager: SessionManager.create(dir, sessionDir) });
		// Persist a conversation first: Pi only creates the session file once a user/assistant message exists.
		await captureTextRequest(first, "hello");
		await first.session.prompt("/subagents mode direct");
		const sessionFile = first.session.sessionFile;
		expect(typeof sessionFile).toBe("string");
		first.session.dispose();

		// A mode chosen in another session lands in the global config file; reopening this one must honor
		// it over the branch entry written above.
		await writeSubagentConfig({ mode: "codemode" });
		const reopened = await harness({
			codemode: "on",
			dir,
			sessionManager: SessionManager.open(sessionFile as string),
		});
		expect(exposures(reopened)).toEqual(SUBAGENT_TOOLS.map(() => "deferred"));

		await reopened.session.prompt("/subagents mode direct");
		const sessionFile2 = reopened.session.sessionFile;
		reopened.session.dispose();

		const third = await harness({
			codemode: "on",
			dir,
			sessionManager: SessionManager.open(sessionFile2 as string),
		});
		expect(exposures(third)).toEqual(SUBAGENT_TOOLS.map(() => "direct"));
	}, 90_000);

	test("deactivating codemode restores direct declarations in explicit auto mode", async () => {
		const h = await harness({ codemode: "on" });
		await h.session.prompt("/subagents mode auto");
		expect(exposures(h)).toEqual(SUBAGENT_TOOLS.map(() => "deferred"));

		h.session.setActiveToolsByName(h.session.getActiveToolNames().filter((name) => name !== "codemode"));
		const context = await captureTextRequest(h, "hello");

		expect(exposures(h)).toEqual(SUBAGENT_TOOLS.map(() => "direct"));
		const names = declaredTools(context).map((tool) => tool.name);
		expect(names).toContain("subagent");
		expect(names).not.toContain("codemode");
	}, 60_000);

	test("an explicit allowlist without subagent tools never activates them", async () => {
		const h = await harness({ codemode: "on", tools: ["read", "bash", "codemode"] });
		const all = h.session.getAllTools().map((tool) => tool.name);
		for (const name of SUBAGENT_TOOLS) expect(all).not.toContain(name);
		expect([...h.session.getActiveToolNames()].sort()).toEqual(["bash", "codemode", "read"]);
	}, 60_000);

	test("tree navigation keeps the globally stored preference in a real session", async () => {
		const h = await harness({ codemode: "on" });
		await captureTextRequest(h, "hello");
		await h.session.prompt("/subagents mode auto");
		expect(
			h.session
				.getAllTools()
				.filter((tool) => (SUBAGENT_TOOLS as readonly string[]).includes(tool.name))
				.map((tool) => tool.exposure),
		).toEqual(SUBAGENT_TOOLS.map(() => "deferred"));

		const target = h.session.getUserMessagesForForking()[0];
		expect(target).toBeDefined();
		const result = await h.session.navigateTree(target!.entryId, { summarize: false });
		expect(result.cancelled).toBe(false);

		// The global preference applies to the new branch too: navigating above the opt-in keeps it.
		expect(
			h.session
				.getAllTools()
				.filter((tool) => (SUBAGENT_TOOLS as readonly string[]).includes(tool.name))
				.map((tool) => tool.exposure),
		).toEqual(SUBAGENT_TOOLS.map(() => "deferred"));
	}, 90_000);

	test("a model-issued invalid call is rejected by real schema validation before execution", async () => {
		const h = await harness({ codemode: false });
		let attempted = false;
		h.faux.setResponses([
			() => {
				if (!attempted) {
					attempted = true;
					return fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "do", thinking: "turbo" })]);
				}
				return fauxAssistantMessage([fauxToolCall("subagent_models", {})]);
			},
			fauxAssistantMessage("done"),
		]);

		await h.session.prompt("make an invalid call");

		const messages = h.session.messages as {
			role?: string;
			toolName?: string;
			content?: { type?: string; text?: string }[];
		}[];
		const rejected = messages.find((message) => message.role === "toolResult" && message.toolName === "subagent");
		expect(rejected).toBeDefined();
		const rejectedText = (rejected?.content ?? []).map((part) => part.text ?? "").join("\n");
		expect(rejectedText).toMatch(/thinking|turbo|invalid/i);
		expect(JSON.stringify(messages)).not.toContain("Background run started");
	}, 90_000);

	test("subagent_models is really callable in the direct profile and reports the faux catalog", async () => {
		const h = await harness({ codemode: false });
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("subagent_models", {})]), fauxAssistantMessage("done")]);

		await h.session.prompt("list models");

		const messages = h.session.messages as {
			role?: string;
			toolName?: string;
			content?: { type?: string; text?: string }[];
		}[];
		const result = messages.find((message) => message.role === "toolResult" && message.toolName === "subagent_models");
		expect(result).toBeDefined();
		const text = (result?.content ?? []).map((part) => part.text ?? "").join("\n");
		// The environment may expose a real catalogue or none at all; both are executed routes, and
		// an empty catalogue must surface as the designed throw rather than a silent empty list.
		expect(text.length).toBeGreaterThan(0);
		if (/model\(s\) available/.test(text)) {
			expect(text).toMatch(/model: "/);
			expect(text).toContain("not a billing quote");
		} else {
			expect(text).toContain("No models can be listed");
		}
	}, 90_000);

	test("deferral still holds at a large inline budget after explicit opt-in", async () => {
		const h = await harness({ codemode: "on", inlineBudget: 1_000_000 });
		await h.session.prompt("/subagents mode auto");
		const context = await captureTextRequest(h, "hello");
		const declarations = declaredTools(context);
		const names = declarations.map((tool) => tool.name);
		for (const name of SUBAGENT_TOOLS) expect(names).not.toContain(name);
		const codemode = declarations.find((tool) => tool.name === "codemode");
		expect(codemode?.description).not.toContain("subagent_status");
		expect(codemode?.description).not.toContain("runId");
	}, 60_000);

	test("legacy direct tools remain callable from a codemode script", async () => {
		const h = await harness({ codemode: "on", inlineBudget: 3000 });
		await h.session.prompt("/subagents mode direct");
		h.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("codemode", {
					code: 'try { return await tools.subagent_status({ runId: "x" }); } catch (error) { return String(error && error.message ? error.message : error); }',
				}),
			]),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("try a nested call");

		const result = lastCodemodeResult(h.session);
		expect(result).toContain("Unknown runId: x");
	}, 60_000);

	test("excludeTools keeps the subagent tools out across mode switches", async () => {
		const h = await harness({ codemode: "on", excludeTools: [...SUBAGENT_TOOLS] });
		expect(h.session.getAllTools().filter((tool) => (SUBAGENT_TOOLS as readonly string[]).includes(tool.name))).toEqual(
			[],
		);

		await h.session.prompt("/subagents mode direct");
		expect(h.session.getAllTools().filter((tool) => (SUBAGENT_TOOLS as readonly string[]).includes(tool.name))).toEqual(
			[],
		);
		expect(
			h.session.getCallableToolNames().filter((name) => (SUBAGENT_TOOLS as readonly string[]).includes(name)),
		).toEqual([]);
	}, 60_000);
});
