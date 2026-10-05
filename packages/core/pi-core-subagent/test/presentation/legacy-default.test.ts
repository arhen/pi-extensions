import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createPresentation, MODE_ENTRY_TYPE } from "../../src/presentation.ts";
import { BASELINE_OPERATIONS } from "../parity/harness.ts";
import {
	captureTextRequest,
	createRuntimeHarness,
	declaredTools,
	lastCodemodeResult,
	type RuntimeHarness,
} from "./runtime-harness.ts";

const sessions: RuntimeHarness[] = [];
afterEach(() => {
	for (const h of sessions.splice(0)) h.cleanup();
});

function controller(branch: unknown[] = []) {
	let active = ["codemode", "subagent", "subagent_status"];
	const definitions = new Map<string, any>();
	const entries: unknown[] = [];
	const p = createPresentation(
		{
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				active = names;
			},
			registerTool: (definition: any) => definitions.set(definition.name, definition),
			appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		} as any,
		["subagent", "subagent_status"].map((name) => ({ name, description: name, parameters: {} }) as any),
	);
	p.registerInitial();
	const ctx = { sessionManager: { getBranch: () => branch } } as any;
	p.restore(ctx);
	p.sync();
	return {
		p,
		definitions,
		entries,
		branch,
		ctx,
		setActive: (names: string[]) => {
			active = names;
		},
	};
}

describe("legacy default requires explicit codemode opt-in", () => {
	test("no branch entry remains direct despite active codemode", () => {
		const h = controller();
		expect(h.p.preference).toBe("direct");
		expect(h.p.applied).toBe("direct");
		expect(h.definitions.get("subagent").exposure).toBe("direct");
		expect(h.definitions.get("subagent").namespace).toBeUndefined();
		expect(h.entries).toEqual([]);
	});

	test("explicit auto opts in and remains branch-scoped", () => {
		const h = controller();
		h.p.setPreference("auto");
		h.p.sync();
		expect(h.p.applied).toBe("codemode");
		expect(h.definitions.get("subagent").exposure).toBe("deferred");
		expect(h.entries).toEqual([{ customType: MODE_ENTRY_TYPE, data: { mode: "auto" } }]);
		h.p.restore(h.ctx);
		h.p.sync();
		expect(h.p.preference).toBe("direct");
		expect(h.p.applied).toBe("direct");
	});

	test.each(["auto", "codemode"])("restored explicit %s is not overwritten", (mode) => {
		const h = controller([{ type: "custom", customType: MODE_ENTRY_TYPE, data: { mode } }]);
		expect(h.p.preference).toBe(mode);
		expect(h.p.applied).toBe("codemode");
	});

	test("codemode activation/deactivation never opts in an unchanged default", () => {
		const h = controller();
		h.setActive(["subagent", "subagent_status"]);
		h.p.sync();
		expect(h.p.applied).toBe("direct");
		h.setActive(["codemode", "subagent", "subagent_status"]);
		h.p.sync();
		expect(h.p.applied).toBe("direct");
	});

	test("native default declares all nine helpers and retains legacy script calls", async () => {
		const h = await createRuntimeHarness({ codemode: "on" });
		sessions.push(h);
		const context = await captureTextRequest(h, "check legacy direct declarations");
		const declared = declaredTools(context).map((tool) => tool.name);
		for (const name of BASELINE_OPERATIONS) {
			expect(declared).toContain(name);
			expect(h.session.getCallableToolNames()).toContain(name);
			expect(h.session.getToolDefinition(name)?.exposure).toBe("direct");
		}
		expect(h.session.systemPrompt).not.toContain("Codemode subagents: call active tools");
		h.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("codemode", {
					code: 'try { return await tools.subagent_status({ runId: "legacy-probe" }); } catch (error) { return String(error); }',
				}),
			]),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("check legacy script compatibility");
		expect(lastCodemodeResult(h.session)).toContain("Unknown runId: legacy-probe");
		await h.session.prompt("/subagents mode auto");
		const opted = await captureTextRequest(h, "check explicitly opted-in routing");
		for (const name of BASELINE_OPERATIONS) expect(declaredTools(opted).map((tool) => tool.name)).not.toContain(name);
		await h.session.prompt("/subagents mode direct");
		const restored = await captureTextRequest(h, "restore legacy direct routing");
		for (const name of BASELINE_OPERATIONS) expect(declaredTools(restored).map((tool) => tool.name)).toContain(name);
	}, 60_000);
});
