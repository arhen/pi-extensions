import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { type FauxProviderHandle, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import subagentExtension from "../../src/index.ts";

export interface RuntimeHarness {
	session: AgentSession;
	faux: FauxProviderHandle;
	dir: string;
	agentDir: string;
	cleanup(): void;
}

export interface RuntimeHarnessOptions {
	codemode?: "on" | "only" | false;
	inlineBudget?: number;
	tools?: string[];
	excludeTools?: string[];
	noTools?: "all" | "builtin";
	sessionManager?: SessionManager;
	dir?: string;
	/** Extra extension factories, e.g. a controlled test tool. */
	extensions?: ((pi: ExtensionAPI) => void)[];
}

/** Real Pi 1.0.1 session: native codemode and the subagent extension driven by a faux provider. */
export async function createRuntimeHarness(options: RuntimeHarnessOptions = {}): Promise<RuntimeHarness> {
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "subagent-runtime-"));
	const agentDir = join(dir, "agent");
	const modelRuntime = await ModelRuntime.create();
	const faux = fauxProvider({ models: [{ id: "faux", name: "Faux" }] });
	modelRuntime.registerNativeProvider(faux.provider);

	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir,
		extensionFactories: [
			...(options.codemode
				? [createCodemodeExtension({ mode: options.codemode, inlineBudget: options.inlineBudget ?? 3000 })]
				: []),
			(pi) => subagentExtension(pi),
			...(options.extensions ?? []),
		],
	});
	await resourceLoader.reload();

	const settingsManager = options.tools
		? SettingsManager.inMemory()
		: SettingsManager.inMemory({ defaultTools: options.codemode ? ["+codemode"] : [] });

	const { session } = await createAgentSession({
		cwd: dir,
		agentDir,
		modelRuntime,
		model: faux.getModel(),
		resourceLoader,
		settingsManager,
		sessionManager: options.sessionManager ?? SessionManager.inMemory(dir),
		...(options.tools ? { tools: options.tools } : {}),
		...(options.excludeTools ? { excludeTools: options.excludeTools } : {}),
		...(options.noTools ? { noTools: options.noTools } : {}),
	});
	await session.bindExtensions({});

	return {
		session,
		faux,
		dir,
		agentDir,
		cleanup: () => {
			try {
				session.dispose();
			} catch {}
			if (!options.dir) rmSync(dir, { recursive: true, force: true });
		},
	};
}

export interface DeclaredTool {
	name: string;
	description: string;
	parameters?: unknown;
}

/** Provider-visible tool declarations: fold the request's system-message loadout patches. */
export function declaredTools(context: TranscriptContext): DeclaredTool[] {
	const active = new Map<string, DeclaredTool>();
	for (const message of context.messages) {
		const candidate = message as { role?: string; toolsAdded?: DeclaredTool[]; toolsRemoved?: DeclaredTool[] };
		if (candidate.role !== "system") continue;
		// Pi folds a system message as removed-then-added: a checkpoint carries the full new set in
		// `toolsAdded` and the replaced set in `toolsRemoved`.
		for (const tool of candidate.toolsRemoved ?? []) active.delete(tool.name);
		for (const tool of candidate.toolsAdded ?? []) active.set(tool.name, tool);
	}
	return [...active.values()];
}

/** Send one prompt whose single model call returns text, and capture that request's context. */
export async function captureTextRequest(h: RuntimeHarness, prompt: string, reply = "ok"): Promise<TranscriptContext> {
	let captured: TranscriptContext | undefined;
	h.faux.setResponses([
		(context) => {
			captured = context;
			return fauxAssistantMessage(reply);
		},
	]);
	await h.session.prompt(prompt);
	if (!captured) throw new Error("runtime harness: no provider request captured");
	return captured;
}

/** Text of the last codemode tool result in the transcript. */
export function lastCodemodeResult(session: AgentSession): string {
	const messages = session.messages as {
		role?: string;
		toolName?: string;
		content?: { type?: string; text?: string }[];
	}[];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "toolResult" && message.toolName === "codemode") {
			return (message.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
		}
	}
	return "";
}
