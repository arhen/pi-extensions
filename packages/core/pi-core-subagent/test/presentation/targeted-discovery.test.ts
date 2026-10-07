import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { CODEMODE_DISCOVERY_GUIDELINE, SUBAGENT_NAMESPACE } from "../../src/presentation.ts";
import { isolateAgentDir } from "./agent-dir.ts";
import { createRuntimeHarness, lastCodemodeResult, type RuntimeHarness } from "./runtime-harness.ts";

const sessions: RuntimeHarness[] = [];
const agentDir = isolateAgentDir();
beforeEach(() => agentDir.reset());
afterEach(() => {
	for (const session of sessions.splice(0)) session.cleanup();
});
afterAll(() => agentDir.restore());

test("the upfront guide names the spawn path and one reusable targeted lookup", () => {
	expect(CODEMODE_DISCOVERY_GUIDELINE).toContain("tools.subagent(args)");
	expect(CODEMODE_DISCOVERY_GUIDELINE).toContain("describeTool('subagent')");
	expect(CODEMODE_DISCOVERY_GUIDELINE).toMatch(/once|reuse/);
	expect(CODEMODE_DISCOVERY_GUIDELINE).not.toContain("searchTools(");
	expect(SUBAGENT_NAMESPACE.instructions).toContain("describeTool('subagent')");
});

test("one native targeted lookup returns the spawn signature, not every helper", async () => {
	const h = await createRuntimeHarness({ codemode: "on" });
	sessions.push(h);
	await h.session.prompt("/subagents mode auto");
	h.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("codemode", { code: "text(await describeTool('subagent'));" })]),
		fauxAssistantMessage("done"),
	]);
	await h.session.prompt("inspect just the spawn signature");
	const result = lastCodemodeResult(h.session);
	expect(result).toContain("Script completed");
	expect(result).toContain("subagent");
	expect(result).toContain("tasks");
	expect(result).toContain("autoAwait");
	expect(result).not.toContain("function subagent_status");
	expect(result).not.toContain("function resume_subagent");
	expect(h.session.systemPrompt).toContain(CODEMODE_DISCOVERY_GUIDELINE);
});

test("targeted lookup cannot reveal an inactive spawn tool", async () => {
	const h = await createRuntimeHarness({ codemode: "on" });
	sessions.push(h);
	await h.session.prompt("/subagents mode auto");
	h.session.setActiveToolsByName(h.session.getActiveToolNames().filter((name) => name !== "subagent"));
	h.faux.setResponses([
		fauxAssistantMessage([
			fauxToolCall("codemode", {
				code: "text((await describeTool('subagent')) === undefined ? 'UNAVAILABLE' : 'FOUND');",
			}),
		]),
		fauxAssistantMessage("done"),
	]);
	await h.session.prompt("inspect an unavailable spawn tool");
	expect(lastCodemodeResult(h.session)).toContain("UNAVAILABLE");
	expect(h.session.getCallableToolNames()).not.toContain("subagent");
});
