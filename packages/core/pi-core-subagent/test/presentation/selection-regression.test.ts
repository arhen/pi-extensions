import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isolateAgentDir } from "./agent-dir.ts";
import {
	captureTextRequest,
	createRuntimeHarness,
	declaredTools,
	lastCodemodeResult,
	type RuntimeHarness,
} from "./runtime-harness.ts";

const helpers = [
	"subagent_models",
	"subagent",
	"subagent_status",
	"subagent_result",
	"await_subagent",
	"reply_subagent",
	"steer_subagent",
	"resume_subagent",
	"subagent_cancel",
];
const sessions: RuntimeHarness[] = [];
const agentDir = isolateAgentDir();
beforeEach(() => agentDir.reset());
afterEach(() => {
	for (const session of sessions.splice(0)) session.cleanup();
});
afterAll(() => agentDir.restore());

async function setup() {
	const h = await createRuntimeHarness({ codemode: "on" });
	sessions.push(h);
	await h.session.prompt("/subagents mode auto");
	h.session.setActiveToolsByName(h.session.getActiveToolNames().filter((name) => !helpers.includes(name)));
	return h;
}

function codemodeResults(h: RuntimeHarness): string[] {
	const messages = h.session.messages as {
		role?: string;
		toolName?: string;
		content?: { type?: string; text?: string }[];
	}[];
	return messages
		.filter((message) => message.role === "toolResult" && message.toolName === "codemode")
		.map((message) => (message.content ?? []).map((part) => part.text ?? "").join("\n"));
}

function ownActive(h: RuntimeHarness): string[] {
	return h.session.getActiveToolNames().filter((name) => helpers.includes(name));
}

function declaredNames(context: TranscriptContext): string[] {
	return declaredTools(context).map((tool) => tool.name);
}

/** Test extension: one tool that toggles another tool's membership in the active set. */
function toggleExtension(toolName: string): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool({
			name: `toggle_${toolName}`,
			label: "Toggle Tool",
			description: `Test-only: toggles ${toolName} in the active set.`,
			parameters: Type.Object({}),
			async execute() {
				const active = pi.getActiveTools();
				const enabled = !active.includes(toolName);
				pi.setActiveTools(enabled ? [...active, toolName] : active.filter((name) => name !== toolName));
				return { content: [{ type: "text", text: `${toolName} enabled: ${enabled}` }], details: {} };
			},
		});
	};
}

/** Test extension: an unrelated declarable tool the allowlist can name. */
function otherToolExtension(): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool({
			name: "other_helper",
			label: "Other Helper",
			description: "Test-only unrelated tool.",
			parameters: Type.Object({}),
			defaultActive: false,
			async execute() {
				return { content: [{ type: "text", text: "other" }], details: {} };
			},
		});
	};
}

/** Test extension: a codemode-callable tool that blocks until the test releases it. */
function gateExtension(): { factory: (pi: ExtensionAPI) => void; started: Promise<void>; release: () => void } {
	let releaseGate!: () => void;
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const factory = (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "hold_gate",
			label: "Hold Gate",
			description: "Test-only: blocks until released.",
			parameters: Type.Object({}),
			exposure: "codemode",
			defaultActive: false,
			async execute() {
				markStarted();
				await gate;
				return { content: [{ type: "text", text: "gate released" }], details: {} };
			},
		});
	};
	return { factory, started, release: () => releaseGate() };
}

const NOT_CALLABLE_SCRIPT = `
try {
  await tools.subagent_status({ runId: "missing" });
  return "CALLED";
} catch (error) {
  return "NOT_CALLABLE: " + String(error && error.message ? error.message : error);
}
`;

const CALLABLE_SCRIPT = `
try {
  const result = await tools.subagent_status({ runId: "missing" });
  return "CALLED: " + JSON.stringify(result).slice(0, 60);
} catch (error) {
  const message = String(error && error.message ? error.message : error);
  return message.includes("Unknown runId") ? "CALLABLE: " + message : "NOT_CALLABLE: " + message;
}
`;

test("mode switches do not reactivate manually deactivated subagent tools", async () => {
	const h = await setup();
	const before = [...h.session.getActiveToolNames()].sort();
	await h.session.prompt("/subagents mode direct");
	expect([...h.session.getActiveToolNames()].sort()).toEqual(before);
});

test("deactivated subagent tools do not become script-callable in the codemode profile", async () => {
	const h = await setup();
	await captureTextRequest(h, "apply the inactive selection at the next boundary");
	expect(h.session.getCallableToolNames().filter((name) => helpers.includes(name))).toEqual([]);
});

test("a partial --tools allowlist does not resurrect deactivated helpers and keeps unrelated names", async () => {
	const h = await createRuntimeHarness({
		codemode: "on",
		tools: ["read", "bash", "codemode", "subagent", "subagent_status", "other_helper"],
		extensions: [otherToolExtension()],
	});
	sessions.push(h);
	expect(ownActive(h).sort()).toEqual(["subagent", "subagent_status"]);
	expect(h.session.getActiveToolNames()).toContain("other_helper");

	h.session.setActiveToolsByName(["read", "bash", "codemode", "other_helper"]);
	await h.session.prompt("/subagents mode direct");

	// The SDK allowlist loop force-activates every declarable name; restoring own membership must win.
	expect(ownActive(h)).toEqual([]);
	expect(h.session.getActiveToolNames()).toContain("other_helper");
	const context = await captureTextRequest(h, "hello");
	expect(declaredNames(context).filter((name) => helpers.includes(name))).toEqual([]);
	expect(declaredNames(context)).toContain("other_helper");

	// Reactivating an own helper under the allowlist must stick across a mode switch too.
	h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "subagent"]);
	await h.session.prompt("/subagents mode codemode");
	expect(ownActive(h)).toEqual(["subagent"]);
	expect(h.session.getToolDefinition("subagent")?.exposure).toBe("deferred");
	expect(h.session.getToolDefinition("subagent_status")?.exposure).toBe("model-only");
});

test("noTools leaves the subagent tools unreachable across mode switches", async () => {
	const h = await createRuntimeHarness({ codemode: "on", noTools: "all" });
	sessions.push(h);
	expect(h.session.getAllTools().filter((tool) => helpers.includes(tool.name))).toEqual([]);

	await h.session.prompt("/subagents mode codemode");
	await h.session.prompt("/subagents mode direct");

	expect(h.session.getAllTools().filter((tool) => helpers.includes(tool.name))).toEqual([]);
	expect(h.session.getCallableToolNames().filter((name) => helpers.includes(name))).toEqual([]);
});

test("codemode availability toggled between model turns reaches the next request", async () => {
	const h = await createRuntimeHarness({ codemode: "on", extensions: [toggleExtension("codemode")] });
	sessions.push(h);
	await h.session.prompt("/subagents mode auto");
	const contexts: TranscriptContext[] = [];
	h.faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("toggle_codemode", {})]),
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("subagent_status", { runId: "missing" })]);
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("toggle_codemode", {})]);
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("codemode", { code: CALLABLE_SCRIPT })]);
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage("done");
		},
	]);

	await h.session.prompt("toggle codemode between turns");
	// Turn 2: codemode is off, so the direct profile declares subagent tools for the same run.
	if (!contexts[0]) throw new Error("no request after codemode deactivation");
	expect(declaredNames(contexts[0])).toContain("subagent_status");
	expect(declaredNames(contexts[0])).not.toContain("codemode");
	if (!contexts[1]) throw new Error("no second direct request");
	expect(declaredNames(contexts[1])).toContain("subagent_status");
	// Turn 4: codemode is active again, so declarations are hidden and scripts can call the helpers.
	if (!contexts[2]) throw new Error("no request after codemode reactivation");
	expect(declaredNames(contexts[2]).filter((name) => helpers.includes(name))).toEqual([]);
	expect(declaredNames(contexts[2])).toContain("codemode");
	expect(lastCodemodeResult(h.session)).toContain("CALLABLE");
	expect(lastCodemodeResult(h.session)).toContain("Unknown runId");
	// The unrelated toggle tool survived every re-registration.
	expect(h.session.getActiveToolNames()).toContain("toggle_codemode");
	expect(h.session.getToolDefinition("subagent_status")?.exposure).toBe("deferred");
});

test("a helper deactivated between model turns becomes non-callable in the same run", async () => {
	const h = await createRuntimeHarness({ codemode: "on", extensions: [toggleExtension("subagent_status")] });
	sessions.push(h);
	await h.session.prompt("/subagents mode auto");
	const contexts: TranscriptContext[] = [];
	h.faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("toggle_subagent_status", {})]),
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("codemode", { code: NOT_CALLABLE_SCRIPT })]);
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("toggle_subagent_status", {})]);
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("codemode", { code: CALLABLE_SCRIPT })]);
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage("done");
		},
	]);

	await h.session.prompt("toggle the helper between turns");

	expect([...ownActive(h)].sort()).toEqual([...helpers].sort());
	const results = codemodeResults(h);
	expect(results[0]).toContain("NOT_CALLABLE");
	expect(results[1]).toContain("CALLABLE");
	for (const context of contexts) expect(declaredNames(context)).not.toContain("subagent_status");
	expect(h.session.getToolDefinition("subagent_status")?.exposure).toBe("deferred");
});

test("a mode change during a blocked live script keeps that call usable and applies next request", async () => {
	const gate = gateExtension();
	const h = await createRuntimeHarness({ codemode: "on", extensions: [gate.factory] });
	sessions.push(h);
	await h.session.prompt("/subagents mode auto");
	let captured: TranscriptContext | undefined;
	h.faux.setResponses([
		() =>
			fauxAssistantMessage([
				fauxToolCall("codemode", {
					code: 'const held = await tools.hold_gate({}); let status = "unavailable"; try { status = JSON.stringify(await tools.subagent_status({ runId: "missing" })).slice(0, 40); } catch (error) { status = "ERR:" + String(error && error.message ? error.message : error); } return "script:" + held + ":" + status;',
				}),
			]),
		(context) => {
			captured = context;
			return fauxAssistantMessage("done");
		},
	]);

	const run = h.session.prompt("start a blocked script");
	await gate.started;
	expect(h.session.getToolDefinition("subagent_status")?.exposure).toBe("deferred");

	// The command runs immediately even while the script is live, but the profile must only be stored.
	await h.session.prompt("/subagents mode direct");
	expect(h.session.getToolDefinition("subagent_status")?.exposure).toBe("deferred");
	// A loadout recompute during the pending switch must honor the applied profile, not the preference.
	h.session.setActiveToolsByName(h.session.getActiveToolNames());
	expect(h.session.getToolDefinition("subagent_status")?.exposure).toBe("deferred");

	gate.release();
	await run;

	expect(captured).toBeDefined();
	if (!captured) throw new Error("no request after the blocked script");
	expect(declaredNames(captured)).toContain("subagent_status");
	expect(h.session.getToolDefinition("subagent_status")?.exposure).toBe("direct");
	const result = lastCodemodeResult(h.session);
	expect(result).toContain("script:gate released:");
	expect(result).toContain("Unknown runId");
});
