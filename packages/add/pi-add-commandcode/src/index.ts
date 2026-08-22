/**
 * Command Code Provider API for pi (https://commandcode.ai/docs/provider).
 *
 * - Login: `/login` → "Command Code" → paste API key, or set COMMANDCODE_API_KEY.
 * - Two endpoints on one base: Claude ids go to `/provider/v1/messages`
 *   (Anthropic Messages), everything else to `/provider/v1/chat/completions`.
 *   Calling the wrong one is a hard 400 `unsupported_model`.
 * - Models: fetched live from `GET /provider/v1/models`. The catalog carries only
 *   id / name / context_length — pricing and vision/reasoning caps are not exposed.
 *   Claude ids reuse pi's built-in Anthropic metadata (same rates, plus adaptive
 *   thinking + temperature flags); the rest come from CATALOG below.
 * - ZDR: `/commandcode zdr on` sends `x-cmd-zdr: 1`; models with no ZDR upstream
 *   then fail 422 `cmd_zdr_no_providers` (no silent non-ZDR fallback).
 *
 * Commands:
 *   /commandcode          status (key, model count, ZDR)
 *   /commandcode zdr [on|off]
 */
import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const BASE_URL = "https://api.commandcode.ai/provider/v1";
// The Anthropic SDK posts to `<baseUrl>/v1/messages`, so Claude models drop the /v1.
const ANTHROPIC_BASE_URL = "https://api.commandcode.ai/provider";
// ponytail: gateway accepts up to 393216 on deepseek, but the cap is per-upstream and
// undocumented. 32k fits reasoning+answer everywhere; raise per model if a run truncates.
// Claude ids use pi's real per-model cap instead.
const MAX_OUTPUT = 32768;
// reasoning_effort accepts low|medium|high|xhigh|max — "none" is a 400, so off is
// unsupported (null) and pi omits the field entirely instead.
const THINKING_MAP = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

// [input, output, cacheRead, cacheWrite, vision, reasoning] — USD per 1M tokens,
// standard (non-long-context) tier. Source: https://commandcode.ai/docs/resources/pricing-limits
// The /models endpoint publishes no pricing or caps; refresh this table when the docs move.
// Claude ids are absent on purpose — ANTHROPIC_MODELS already has them, verified identical.
type Row = [number, number, number, number, 0 | 1, 0 | 1];
const CATALOG: Record<string, Row> = {
  "gpt-5.6-sol": [5, 30, 0.5, 6.25, 1, 1],
  "gpt-5.6-terra": [2, 12, 0.2, 2.5, 1, 1],
  "gpt-5.6-luna": [0.2, 1.2, 0.02, 0.25, 1, 1],
  "gpt-5.5": [5, 30, 0.5, 0, 1, 1],
  "gpt-5.4": [2.5, 15, 0.25, 0, 1, 1],
  "gpt-5.3-codex": [2, 8, 0.5, 0, 1, 1],
  "gpt-5.4-mini": [0.75, 4.5, 0.075, 0, 1, 1],
  "deepseek/deepseek-v4-pro": [0.66, 1.98, 0.022, 0, 0, 1],
  "deepseek/deepseek-v4-flash": [0.22, 0.66, 0.007, 0, 0, 1],
  "deepseek/deepseek-v4-flash-vision-exp": [0.22, 0.66, 0.01, 0, 1, 1],
  "moonshotai/Kimi-K3": [3, 15, 0.3, 0, 1, 1],
  "moonshotai/Kimi-K2.7-Code": [0.95, 4, 0.19, 0, 1, 1],
  "moonshotai/Kimi-K2.7-Code-Highspeed": [1.9, 8, 0.38, 0, 1, 1],
  "moonshotai/Kimi-K2.6": [0.95, 4, 0.16, 0, 1, 0],
  "moonshotai/Kimi-K2.5": [0.6, 3, 0.1, 0, 1, 0],
  "zai-org/GLM-5.3": [1.4, 4.4, 0.26, 0, 0, 1],
  "zai-org/GLM-5.2": [1.4, 4.4, 0.26, 0, 0, 1],
  "zai-org/GLM-5.2-Fast": [3, 10.25, 0.5, 0, 0, 0],
  "zai-org/GLM-5.1": [1.4, 4.4, 0.26, 0, 0, 0],
  "zai-org/GLM-5": [1, 3.2, 0.2, 0, 0, 0],
  "MiniMaxAI/MiniMax-M3": [0.3, 1.2, 0.06, 0, 1, 1],
  "MiniMaxAI/MiniMax-M2.7": [0.3, 1.2, 0.06, 0, 0, 0],
  "MiniMaxAI/MiniMax-M2.5": [0.3, 1.2, 0.03, 0, 0, 0],
  "xiaomi/mimo-v2.5-pro": [0.435, 0.87, 0.0036, 0, 0, 0],
  "xiaomi/mimo-v2.5": [0.14, 0.28, 0.0028, 0, 1, 0],
  "Qwen/Qwen3.8-Max": [2, 6, 0.25, 2.5, 1, 1],
  "Qwen/Qwen3.8-27B": [0.4, 3, 0.04, 0, 1, 1],
  "Qwen/Qwen3.7-Max": [2.5, 7.5, 0.5, 3.13, 0, 1],
  "Qwen/Qwen3.7-Plus": [0.4, 1.6, 0.08, 0.5, 1, 1],
  "Qwen/Qwen3.7-Flash": [0.03, 0.13, 0.006, 0.038, 1, 1],
  "Qwen/Qwen3.6-Max-Preview": [1.3, 7.8, 0.26, 1.63, 0, 1],
  "Qwen/Qwen3.6-Plus": [0.5, 3, 0.1, 0, 1, 1],
  "stepfun/Step-3.7-Flash": [0.2, 1.15, 0.04, 0, 1, 1],
  "stepfun/Step-3.5-Flash": [0.1, 0.3, 0.02, 0, 0, 1],
  "tencent/hy3-paid": [0.14, 0.58, 0.035, 0, 0, 1],
  "google/gemini-3.7-flash": [0.75, 3.75, 0.075, 0.04167, 1, 1],
  "google/gemini-3.6-flash": [1.5, 7.5, 0.15, 0, 1, 1],
  "google/gemini-3.5-flash": [1.5, 9, 0.15, 0, 1, 1],
  "google/gemini-3.5-flash-lite": [0.3, 2.5, 0.03, 0, 1, 1],
  "google/gemini-3.1-flash-lite": [0.25, 1.5, 0.03, 0, 1, 1],
  "sakana/fugu-ultra": [5, 30, 0.5, 0, 1, 1],
  "nvidia/nemotron-3-ultra-550b-a55b": [0.6, 2.4, 0.12, 0, 0, 1],
  "thinkingmachines/inkling": [1, 4.05, 0.17, 0, 1, 1],
  "thinkingmachines/inkling-small": [0.5, 1.2, 0.1, 0, 1, 1],
  "stealth/ox-alpha": [0, 0, 0, 0, 1, 1],
  "poolside/laguna-s-2.1-free": [0, 0, 0, 0, 0, 1],
  "meta/muse-spark-1.1": [1.25, 4.25, 0.15, 0, 1, 1],
  "meta/muse-spark-1.2": [1.25, 4.25, 0.15, 0, 1, 1],
  "meta/muse-spark-1.2-contributor": [0.1, 0.2, 0.002, 0, 1, 1],
  "xai/grok-4.5": [2, 6, 0.5, 0, 1, 1],
  "xai/grok-4.6": [2, 6, 0.5, 0, 0, 1],
};

interface ModelCard {
  id: string;
  name?: string;
  context_length?: number;
}

const stateFile = join(getAgentDir(), "commandcode.json");
let zdrOn = false;

async function loadState() {
  try {
    zdrOn = JSON.parse(await readFile(stateFile, "utf8")).zdr === true;
  } catch {
    zdrOn = false;
  }
}
async function saveState() {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ zdr: zdrOn }));
}

const isClaude = (id: string) => id.startsWith("claude-");

// `persist` stores full Model objects, so the provider tag has to be on each entry.
type MappedModel = ProviderModelConfig & {
  provider: string;
  baseUrl: string;
  api: "anthropic-messages" | "openai-completions";
};

// ANTHROPIC_MODELS is a literal-keyed catalog; we look up ids that come from the wire.
const BUILTIN_CLAUDE = ANTHROPIC_MODELS as Record<string, MappedModel | undefined>;

function mapModel(m: ModelCard): MappedModel {
  const builtin = BUILTIN_CLAUDE[m.id];
  if (isClaude(m.id) && builtin) {
    // Reuse pi's Anthropic metadata wholesale: rates match the Command Code docs,
    // and it carries forceAdaptiveThinking / supportsTemperature, which a
    // hand-written entry would silently drop.
    return {
      ...builtin,
      provider: "commandcode",
      api: "anthropic-messages",
      baseUrl: ANTHROPIC_BASE_URL,
      contextWindow: m.context_length ?? builtin.contextWindow,
    };
  }
  const [input, output, cacheRead, cacheWrite, vision, reasoning] = CATALOG[
    m.id
  ] ?? [0, 0, 0, 0, 0, 1];
  return {
    id: m.id,
    name: m.name ?? m.id,
    provider: "commandcode",
    api: "openai-completions",
    baseUrl: BASE_URL,
    reasoning: reasoning === 1,
    thinkingLevelMap: THINKING_MAP,
    input: vision ? ["text", "image"] : ["text"],
    cost: { input, output, cacheRead, cacheWrite },
    contextWindow: m.context_length ?? 200_000,
    maxTokens: MAX_OUTPUT,
    compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens" },
  };
}

function commandcodeKey(): string | undefined {
  const cred = readStoredCredential("commandcode");
  return (
    (cred?.type === "api_key" ? cred.key : undefined) ??
    process.env.COMMANDCODE_API_KEY
  );
}

async function refreshModels(
  context: RefreshModelsContext,
): Promise<ProviderModelConfig[]> {
  if (context.allowNetwork === false) return [...(context.stored?.models ?? [])];
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = context.credential?.key ?? commandcodeKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (context.stored?.etag) headers["If-None-Match"] = context.stored.etag;
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/models`, { headers, signal: context.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return [...(context.stored?.models ?? [])]; // offline: keep last-known catalog
  }
  if (res.status === 304) {
    await context.publish({ persist: context.stored });
    return [...(context.stored?.models ?? [])];
  }
  if (!res.ok) {
    console.error(
      `[commandcode] models fetch failed: ${res.status} ${res.statusText}`,
    );
    return [...(context.stored?.models ?? [])];
  }
  const data = (await res.json()) as { data?: ModelCard[] };
  const models = (data.data ?? []).map(mapModel);
  await context.publish({
    persist: {
      models,
      etag: res.headers.get("etag") ?? undefined,
      lastModified:
        Date.parse(res.headers.get("last-modified") ?? "") || undefined,
      checkedAt: Date.now(),
    },
  });
  return models;
}

export default async function (pi: ExtensionAPI) {
  await loadState();

  const registerProvider = () => {
    const config: ProviderConfig = {
      name: "Command Code",
      baseUrl: BASE_URL,
      api: "openai-completions",
      apiKey: "$COMMANDCODE_API_KEY",
      authHeader: true,
      headers: zdrOn ? { "x-cmd-zdr": "1" } : undefined,
      refreshModels,
    };
    pi.registerProvider("commandcode", config);
  };
  registerProvider();

  const syncStatus = (
    ctx: { ui: { setStatus(k: string, v: string | undefined): void } },
    model?: { provider?: string },
  ) => {
    const on = model?.provider === "commandcode" && zdrOn;
    ctx.ui.setStatus("commandcode", on ? "ZDR" : undefined);
  };

  pi.on("session_start", async (_event, ctx) => {
    syncStatus(ctx, ctx.model);
    if (commandcodeKey()) {
      void ctx.modelRegistry
        .refresh({ providers: ["commandcode"] })
        .catch(() => {});
    }
  });

  pi.on("model_select", (event, ctx) => {
    syncStatus(ctx, event.model);
  });

  pi.registerCommand("commandcode", {
    description: "Command Code: status / zdr [on|off]",
    handler: async (args, ctx) => {
      const [cmd, ...rest] = (args ?? "").trim().split(/\s+/);
      switch (cmd) {
        case "zdr": {
          zdrOn = rest[0] === "on" ? true : rest[0] === "off" ? false : !zdrOn;
          await saveState();
          registerProvider(); // re-register so the ZDR header change takes effect
          syncStatus(ctx, ctx.model);
          ctx.ui.notify(
            `Command Code ZDR ${zdrOn ? "ON" : "off"} — ${
              zdrOn
                ? "requests send x-cmd-zdr: 1; models with no ZDR upstream fail with 422 cmd_zdr_no_providers"
                : "requests may route to any upstream"
            }`,
            zdrOn ? "warning" : "info",
          );
          return;
        }
        default: {
          const n =
            ctx.modelRegistry.getProvider("commandcode")?.getModels().length ??
            0;
          ctx.ui.notify(
            `Command Code: ${commandcodeKey() ? "logged in" : "no key (/login → Command Code or COMMANDCODE_API_KEY)"} · ` +
              `${n} models · ZDR ${zdrOn ? "on" : "off"}\n` +
              `Subcommand: /commandcode zdr [on|off]`,
            "info",
          );
        }
      }
    },
  });
}
