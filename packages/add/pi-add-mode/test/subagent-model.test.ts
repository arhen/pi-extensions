import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import subagentExtension from "../../../core/pi-core-subagent/src/index.ts";
import modeExtension from "../src/index.ts";

/**
 * Mode + subagent in one real Pi session. The leader runs on `faux/leader` and asks for itself as the
 * subagent model; the mode says subagents run on `faux/worker`. Children are recognised by the model
 * the faux provider was called with.
 */
const root = mkdtempSync(join(tmpdir(), "mode-subagent-"));
const agentDir = join(root, "agent");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.HOME = root;
});
afterAll(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(root, { recursive: true, force: true });
});

const sessions: AgentSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});

interface Harness {
	session: AgentSession;
	childCalls: { model: string; reasoning?: string }[];
	run(leaderCall: (context: TranscriptContext) => ReturnType<typeof fauxAssistantMessage>): Promise<void>;
}

async function harness(leaderOverride: boolean, codemode: boolean): Promise<Harness> {
	const dir = mkdtempSync(join(root, "cwd-"));
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "modes.json"),
		JSON.stringify({
			Lead: {
				tools: "default",
				model: "faux/leader",
				thinking: "high",
				subagentModel: "faux/worker",
				subagentThinking: "low",
				leaderOverride,
			},
		}),
	);
	const modelRuntime = await ModelRuntime.create();
	const faux = fauxProvider({
		models: [
			{ id: "leader", reasoning: true },
			{ id: "worker", reasoning: true },
		],
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir,
		extensionFactories: [
			...(codemode ? [createCodemodeExtension({ mode: "on", inlineBudget: 3000 })] : []),
			(pi) => subagentExtension(pi),
			(pi) => modeExtension(pi),
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir,
		modelRuntime,
		model: faux.getModel("leader"),
		resourceLoader,
		settingsManager: SettingsManager.inMemory({ defaultTools: codemode ? ["+codemode"] : [] }),
		sessionManager: SessionManager.inMemory(dir),
	});
	await session.bindExtensions({});
	sessions.push(session);
	await session.prompt("/mode Lead");

	const childCalls: Harness["childCalls"] = [];
	let done: () => void = () => {};
	const finished = new Promise<void>((resolve) => {
		done = resolve;
	});
	return {
		session,
		childCalls,
		async run(leaderCall) {
			faux.setResponses(
				Array.from({ length: 12 }, () => async (context: TranscriptContext, options, _state, model) => {
					if (JSON.stringify(context.messages).includes("You are running as a subagent")) {
						childCalls.push({ model: `${model.provider}/${model.id}`, reasoning: options?.reasoning });
						done();
						return fauxAssistantMessage("CHILD_DONE");
					}
					const spawned = context.messages.some((m) => m.role === "toolResult");
					if (!spawned) return leaderCall(context);
					await finished;
					return fauxAssistantMessage("LEADER_DONE");
				}),
			);
			await session.prompt("delegate");
			await finished;
		},
	};
}

const pinned = { agent: "worker", task: "do it", model: "faux/leader", thinking: "high" };

describe("mode subagent model with a real Pi session", () => {
	test("leader override off: a direct subagent call runs on the mode's model and effort", async () => {
		const h = await harness(false, false);
		await h.run(() => fauxAssistantMessage([fauxToolCall("subagent", pinned)]));
		expect(h.childCalls[0]).toEqual({ model: "faux/worker", reasoning: "low" });
	}, 60_000);

	test("leader override off: a codemode tools.subagent call is enforced too", async () => {
		const h = await harness(false, true);
		await h.run(() =>
			fauxAssistantMessage([
				fauxToolCall("codemode", { code: `return await tools.subagent(${JSON.stringify(pinned)});` }),
			]),
		);
		expect(h.childCalls[0]).toEqual({ model: "faux/worker", reasoning: "low" });
	}, 60_000);

	test("leader override on: the leader's explicit model and effort win", async () => {
		const h = await harness(true, false);
		await h.run(() => fauxAssistantMessage([fauxToolCall("subagent", pinned)]));
		expect(h.childCalls[0]).toEqual({ model: "faux/leader", reasoning: "high" });
	}, 60_000);

	test("leader override on: a task without a model still gets the mode default", async () => {
		const h = await harness(true, false);
		await h.run(() => fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "do it" })]));
		expect(h.childCalls[0]).toEqual({ model: "faux/worker", reasoning: "low" });
	}, 60_000);
});
