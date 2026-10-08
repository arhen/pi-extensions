import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import {
	type DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";

type ChildExtensionFactories = ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"];

/**
 * Children run with `noExtensions`, so they get none of the configured extensions — codemode is the
 * one exception, because it is how a child batches tool calls. `createCodemodeExtension()` is the
 * supported factory (pi >= 1.0); hosts that do not export it simply give children no codemode.
 */
export async function codemodeFactories(): Promise<ChildExtensionFactories> {
	try {
		const host = (await import("@earendil-works/pi-coding-agent")) as unknown as {
			createCodemodeExtension?: () => unknown;
		};
		const factory = host.createCodemodeExtension?.();
		return factory ? ([factory] as ChildExtensionFactories) : [];
	} catch {
		return [];
	}
}

/**
 * A resumed task keeps its stored thinking level, clamped to what the target model accepts — a
 * resume that swaps model must not fail on an effort the new model does not define.
 */
export function clampResumeThinking(
	model: Model<Api> | undefined,
	thinking: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
	if (!thinking || !model) return thinking;
	return clampThinkingLevel(model, thinking) as ThinkingLevel;
}

const PROBE_THINKING_LEVELS: ThinkingLevel[] = ["low", "minimal", "medium", "high", "xhigh", "max"];

/**
 * Thinking level for the usability probe: exactly what the child session will send — the clamped
 * requested level, or the cheapest the model accepts when none was requested. Probing without a
 * level makes adaptive-thinking providers reject the request (9router claude models answer
 * "thinking.type.disabled is not supported"), which used to make every preflight fail and fall
 * back to the session model.
 */
function probeThinking(model: Model<Api>, thinking?: string): ThinkingLevel | undefined {
	if (!model.reasoning) return undefined;
	const supported = getSupportedThinkingLevels(model);
	if (thinking && thinking !== "off") return clampThinkingLevel(model, thinking as ThinkingLevel);
	// the child clamps an unsupported "off" up to its cheapest level, so probe that instead
	if (thinking === "off") return supported.includes("off") ? undefined : supported[0];
	return PROBE_THINKING_LEVELS.find((level) => supported.includes(level));
}

async function probeModel(
	ctx: ExtensionContext,
	model: Model<Api>,
	signal: AbortSignal | undefined,
	thinking?: string,
): Promise<string | undefined> {
	try {
		const reasoningEffort = probeThinking(model, thinking);
		const reply = await ctx.modelRegistry.complete(
			model,
			{ messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
			{ maxTokens: 16, signal, ...(reasoningEffort ? { reasoningEffort } : {}) },
		);
		return reply.stopReason === "error" ? (reply.errorMessage ?? "provider returned an error") : undefined;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

export async function ensureUsableModel(
	ctx: ExtensionContext,
	model: Model<Api> | undefined,
	signal: AbortSignal | undefined,
	thinking?: string,
): Promise<{ model: Model<Api> | undefined; note?: string }> {
	const session = ctx.model;
	if (!model || !ctx.modelRegistry) return { model };
	if (session && model.provider === session.provider && model.id === session.id) return { model };
	const error = await probeModel(ctx, model, signal, thinking);
	if (!error) return { model };
	if (model.provider === "opencode-go" && /MissingSessionID|x-opencode-session/i.test(error)) {
		// ponytail: opencode-go rejects stateless probes but accepts AgentSession requests, which add the session header.
		// Upgrade path: remove this exception when modelRegistry.complete can carry AgentSession request transforms.
		return { model, note: `preflight unavailable (${error}); child session will validate the model` };
	}
	if (!session) throw new Error(`Model ${model.provider}/${model.id} is unusable: ${error}`);
	return {
		model: session,
		note: `${model.provider}/${model.id} failed preflight (${error}); using session model ${session.provider}/${session.id}`,
	};
}

export async function createChildModelRuntime(ctx: ExtensionContext) {
	const ids = ctx.modelRegistry.getRegisteredProviderIds?.() ?? [];
	if (ids.length === 0) return undefined;
	const agentDir = getAgentDir();
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	for (const id of ids) {
		const native = ctx.modelRegistry.getRegisteredNativeProvider?.(id);
		if (native) {
			runtime.registerNativeProvider(native);
			continue;
		}
		const config = ctx.modelRegistry.getRegisteredProviderConfig?.(id);
		if (config) runtime.registerProvider(id, config);
	}
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

export function validateThinking(model: Model<Api> | undefined, level: string | undefined): void {
	if (!level || level === "off") return;
	if (!model) return;
	const map = model.thinkingLevelMap;
	if (map && level in map && map[level as keyof typeof map] === null) {
		const supported = Object.keys(map).filter((k) => map[k as keyof typeof map] !== null);
		throw new Error(
			`Thinking level "${level}" is not supported by ${model.provider}/${model.id}. Supported: ${supported.length ? supported.join(" | ") : 'none — use thinking: "off"'}.`,
		);
	}
	if (!model.reasoning) {
		throw new Error(`Model ${model.provider}/${model.id} does not support thinking. Use thinking: "off".`);
	}
}
