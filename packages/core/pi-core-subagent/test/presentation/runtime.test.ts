import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BASELINE_OPERATIONS } from "../parity/harness.ts";
import {
	captureTextRequest,
	createRuntimeHarness,
	declaredTools,
	lastCodemodeResult,
	type RuntimeHarness,
} from "./runtime-harness.ts";

const SUBAGENT_TOOLS = [...BASELINE_OPERATIONS];

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

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
	test("auto without codemode declares model-only subagent tools", async () => {
		const h = await harness({ codemode: false });
		expect(exposures(h)).toEqual(SUBAGENT_TOOLS.map(() => "model-only"));
		expect(h.session.getActiveToolNames()).toContain("subagent");

		const context = await captureTextRequest(h, "hello");
		const names = declaredTools(context).map((tool) => tool.name);
		expect(names).toContain("subagent");
		expect(names).toContain("subagent_status");
		expect(names).not.toContain("codemode");
	}, 60_000);

	test("auto with codemode on keeps deferred tools out of declarations and the catalog", async () => {
		const h = await harness({ codemode: "on", inlineBudget: 3000 });
		expect(exposures(h)).toEqual(SUBAGENT_TOOLS.map(() => "deferred"));
		// Retained active selection: the tools stay active but their declarations are hidden.
		expect(h.session.getActiveToolNames()).toContain("subagent");

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

	test("global codemode.mode=only keeps an explicit direct profile declared", async () => {
		const h = await harness({ codemode: "only", inlineBudget: 3000 });
		await h.session.prompt("/subagents mode direct");

		const context = await captureTextRequest(h, "hello");
		const declarations = declaredTools(context);
		const names = declarations.map((tool) => tool.name);
		expect(names).toContain("subagent");
		expect(names).toContain("subagent_status");
		expect(names).not.toContain("read");

		const codemode = declarations.find((tool) => tool.name === "codemode");
		expect(codemode?.description).not.toContain("runId");

		expect(h.session.systemPrompt).toContain("Define and delegate");
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

	test("reopening a persisted session restores the branch preference", async () => {
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

		const reopened = await harness({
			codemode: "on",
			dir,
			sessionManager: SessionManager.open(sessionFile as string),
		});
		expect(exposures(reopened)).toEqual(SUBAGENT_TOOLS.map(() => "model-only"));

		await reopened.session.prompt("/subagents mode codemode");
		const sessionFile2 = reopened.session.sessionFile;
		reopened.session.dispose();

		const third = await harness({
			codemode: "on",
			dir,
			sessionManager: SessionManager.open(sessionFile2 as string),
		});
		expect(exposures(third)).toEqual(SUBAGENT_TOOLS.map(() => "deferred"));
	}, 90_000);

	test("deactivating codemode restores direct declarations at the next boundary", async () => {
		const h = await harness({ codemode: "on" });
		expect(exposures(h)).toEqual(SUBAGENT_TOOLS.map(() => "deferred"));

		h.session.setActiveToolsByName(h.session.getActiveToolNames().filter((name) => name !== "codemode"));
		const context = await captureTextRequest(h, "hello");

		expect(exposures(h)).toEqual(SUBAGENT_TOOLS.map(() => "model-only"));
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
});
