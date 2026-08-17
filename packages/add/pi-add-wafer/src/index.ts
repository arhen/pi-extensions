/**
 * Wafer Serverless provider for pi.
 *
 * - Login: `/login` → "Wafer Serverless" → paste API key (stored in pi's auth.json),
 *   or set WAFER_API_KEY env var.
 * - Models: fetched live from `GET https://pass.wafer.ai/v1/models` (refreshable),
 *   mapped with context window, max output, cost, reasoning/effort (zai thinking
 *   format: `thinking:{type}` + `reasoning_effort`), and ZDR capability.
 * - Status: pi's built-in footer shows session totals (↑input ↓output Rcache Wcache
 *   CH% $cost) from message usage + per-model cost. `/wafer usage` shows account-level
 *   read tokens, cache hit rate and estimated cost from Wafer's usage/metrics APIs.
 *
 * Commands:
 *   /wafer            status summary (key, model count, ZDR)
 *   /wafer zdr [on|off]   toggle request-scoped Zero Data Retention (re-registers +
 *                         refetches catalog; non-ZDR models hidden while on)
 *   /wafer refresh    force-refetch model catalog
 *   /wafer models     list models with configs (widget below editor)
 *   /wafer usage      account usage 7d + cache hit rate 24h
 *   /wafer hide       clear the models widget
 */
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const PASS_BASE = "https://pass.wafer.ai/v1";
const API_BASE = "https://api.wafer.ai/v1";
// ponytail: model cards expose no max-output field; 32k fits reasoning+answer for all
// current catalog models. Override per model via models.json when needed.
const DEFAULT_MAX_OUTPUT = 32768;
// Wafer reasoning_effort: none|low|medium|high|max. "off" is handled by pi itself.
const THINKING_MAP = {
  minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

interface WaferModelCard {
  id: string;
  zdr_supported?: boolean;
  max_model_len?: number;
  wafer?: {
    display_name?: string;
    context_length?: number;
    max_output_tokens?: number;
    capabilities?: { vision?: boolean; reasoning?: boolean };
    pricing?: {
      input_cents_per_million?: number;
      output_cents_per_million?: number;
      cache_read_cents_per_million?: number;
    };
  };
}

type MappedModel = ProviderModelConfig & { provider: string; baseUrl: string; api: "openai-completions" };

const stateFile = join(getAgentDir(), "wafer.json");
let zdrOn = false;
let lastSpendCents = 0;
let lastSpendFetched = 0;
let lastCatalog: WaferModelCard[] = [];

async function loadState() {
  try {
    const s = JSON.parse(await readFile(stateFile, "utf8"));
    zdrOn = s.zdr === true;
    lastSpendCents = s.spend ?? 0;
    lastSpendFetched = s.spendAt ?? 0;
  } catch {
    zdrOn = false;
  }
}
async function saveState() {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ zdr: zdrOn, spend: lastSpendCents, spendAt: lastSpendFetched }));
}

const cents = (v?: number) => (typeof v === "number" ? v / 100 : 0);

function mapModel(m: WaferModelCard): MappedModel {
  const w = m.wafer ?? {};
  const caps = w.capabilities ?? {};
  const pricing = w.pricing ?? {};
  return {
    id: m.id,
    name: w.display_name ?? m.id,
    api: "openai-completions",
    provider: "wafer",
    baseUrl: PASS_BASE,
    reasoning: caps.reasoning === true,
    thinkingLevelMap: THINKING_MAP,
    input: caps.vision ? ["text", "image"] : ["text"],
    cost: {
      input: cents(pricing.input_cents_per_million),
      output: cents(pricing.output_cents_per_million),
      cacheRead: cents(pricing.cache_read_cents_per_million),
      cacheWrite: 0,
    },
    contextWindow: m.max_model_len ?? w.context_length ?? 200000,
    maxTokens: w.max_output_tokens ?? DEFAULT_MAX_OUTPUT,
    compat: { thinkingFormat: "zai", supportsReasoningEffort: true, zaiToolStream: false, cacheControlFormat: "anthropic" },
  };
}

async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
  const key = context.credential?.key ?? process.env.WAFER_API_KEY;
  if (!key || context.allowNetwork === false) return [...(context.stored?.models ?? [])];
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  if (context.stored?.etag) headers["If-None-Match"] = context.stored.etag;
  let res: Response;
  try {
    res = await fetch(`${PASS_BASE}/models`, { headers, signal: context.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return [...(context.stored?.models ?? [])]; // offline: keep last-known catalog
  }
  if (res.status === 304) {
    await context.publish({ persist: context.stored });
    return [...(context.stored?.models ?? [])];
  }
  if (!res.ok) {
    console.error(`[wafer] models fetch failed: ${res.status} ${res.statusText}`);
    return [...(context.stored?.models ?? [])];
  }
  const data = (await res.json()) as { data: WaferModelCard[] };
  lastCatalog = data.data;
  const models = data.data.filter((m) => !zdrOn || m.zdr_supported === true).map(mapModel);
  const lastModified = Date.parse(res.headers.get("last-modified") ?? "") || undefined;
  await context.publish({
    persist: { models, etag: res.headers.get("etag") ?? undefined, lastModified, checkedAt: Date.now() },
  });
  return models;
}

function waferKey(): string | undefined {
  const cred = readStoredCredential("wafer");
  return (cred?.type === "api_key" ? cred.key : undefined) ?? process.env.WAFER_API_KEY;
}

async function fetchJson(url: string, key: string, signal?: AbortSignal): Promise<any | undefined> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal });
    if (!res.ok) {
      console.error(`[wafer] ${res.status} for ${url}`);
      return undefined;
    }
    return await res.json();
  } catch (err) {
    console.error(`[wafer] request failed: ${(err as Error).message}`);
    return undefined;
  }
}

const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${n}`;

export default async function (pi: ExtensionAPI) {
  await loadState();

  const registerProvider = () => {
    const config: ProviderConfig = {
      name: "Wafer Serverless",
      baseUrl: PASS_BASE,
      api: "openai-completions",
      apiKey: "$WAFER_API_KEY",
      authHeader: true,
      headers: zdrOn ? { "Wafer-ZDR": "required" } : undefined,
      refreshModels,
    };
    pi.registerProvider("wafer", config);
  };
  registerProvider();

  const statusText = () => (zdrOn ? "ZDR" : ""); // spend removed: redundant with pi's built-in session cost

  // Footer status only while a wafer model is active.
  const syncStatus = (ctx: { ui: { setStatus(k: string, v: string | undefined): void } }, model?: { provider?: string }) => {
    const active = model?.provider === "wafer";
    ctx.ui.setStatus("wafer", active ? statusText() || undefined : undefined);
  };

  pi.on("session_start", async (_event, ctx) => {
    syncStatus(ctx, ctx.model);
    // Startup refresh is offline-only; fetch the live catalog when a key exists.
    if (waferKey()) {
      void ctx.modelRegistry.refresh({ providers: ["wafer"] }).catch(() => {});
    }
  });

  pi.on("model_select", (event, ctx) => {
    syncStatus(ctx, event.model);
  });

  pi.registerCommand("wafer", {
    description: "Wafer serverless: status / zdr [on|off] / refresh / models / usage / hide",
    handler: async (args, ctx) => {
      const [cmd, ...rest] = (args ?? "").trim().split(/\s+/);
      switch (cmd) {
        case "zdr": {
          const next = rest[0] === "on" ? true : rest[0] === "off" ? false : !zdrOn;
          zdrOn = next;
          await saveState();
          registerProvider(); // re-register with new ZDR header (keeps existing models)
          await ctx.modelRegistry.refresh({ providers: ["wafer"], force: true }); // refetch + filter
          ctx.ui.setStatus("wafer", statusText() || undefined);
          ctx.ui.notify(
            `Wafer ZDR ${zdrOn ? "ON" : "off"} — ${zdrOn ? "requests send Wafer-ZDR: required, non-ZDR models hidden" : "requests may route to any partition"}`,
            zdrOn ? "warning" : "info",
          );
          return;
        }
        case "refresh": {
          ctx.ui.notify("Refreshing Wafer model catalog…", "info");
          await ctx.modelRegistry.refresh({ providers: ["wafer"], force: true });
          const n = ctx.modelRegistry.getProvider("wafer")?.getModels().length ?? 0;
          ctx.ui.notify(`Wafer catalog refreshed: ${n} models`, "info");
          return;
        }
        case "models": {
          const models = ctx.modelRegistry.getProvider("wafer")?.getModels() ?? [];
          const zdrOk = new Set(lastCatalog.filter((m) => m.zdr_supported === true).map((m) => m.id));
          const lines = ["Wafer models — ctx / max output / reasoning / ZDR:"];
          for (const m of models) {
            lines.push(
              `${m.id}  ctx=${fmtTokens(m.contextWindow)}  out=${fmtTokens(m.maxTokens)}  ` +
                `reasoning=${m.reasoning ? "on" : "off"}  ${zdrOk.has(m.id) ? "zdr" : "no-zdr"}`,
            );
          }
          if (models.length === 0) lines.push("(no models — /login → Wafer Serverless, then /wafer refresh)");
          ctx.ui.setWidget("wafer-models", lines, { placement: "belowEditor" });
          ctx.ui.notify(`Wafer: ${models.length} models (listed below editor, /wafer hide to clear)`, "info");
          return;
        }
        case "hide": {
          ctx.ui.setWidget("wafer-models", undefined);
          return;
        }
        case "usage":
        case "status": {
          const key = waferKey();
          if (!key) {
            ctx.ui.notify("Wafer not logged in. Run /login → Wafer Serverless, or set WAFER_API_KEY.", "warning");
            return;
          }
          ctx.ui.notify("Fetching Wafer usage…", "info");
          const [usage, metrics] = await Promise.all([
            fetchJson(`${API_BASE}/usage/me?period=1d&endpoint=pass.wafer.ai`, key),
            fetchJson(`${API_BASE}/endpoints/metrics?endpoint=pass.wafer.ai&range_minutes=1440`, key),
          ]);
          const t = usage ?? {};
          const s = metrics?.summary ?? {};
          const cacheHit = s.cache_hit_pct;
          const spend = t.total_estimated_cost_cents ?? 0;
          lastSpendCents = spend;
          lastSpendFetched = Date.now();
          await saveState();
          ctx.ui.setStatus("wafer", statusText() || undefined);
          ctx.ui.notify(
            `Wafer 24h: ↑${fmtTokens(t.total_input_tokens ?? 0)} ↓${fmtTokens(t.total_output_tokens ?? 0)} ` +
              `R${fmtTokens(t.total_cache_read_tokens ?? 0)} · ${t.total_requests ?? 0} req · ` +
              `≈$${((t.total_estimated_cost_cents ?? 0) / 100).toFixed(2)}` +
              (cacheHit != null ? ` · cache hit ${cacheHit.toFixed(1)}% (24h)` : "") +
              (s.tps_p50 != null ? ` · tps p50=${s.tps_p50.toFixed(0)} p90=${(s.tps_p90 ?? 0).toFixed(0)}` : ""),
            "info",
          );
          return;
        }
        default: {
          const key = waferKey();
          const n = ctx.modelRegistry.getProvider("wafer")?.getModels().length ?? 0;
          ctx.ui.notify(
            `Wafer: ${key ? "logged in" : "no key (/login → Wafer Serverless or WAFER_API_KEY)"} · ` +
              `${n} models · ZDR ${zdrOn ? "on" : "off"}\n` +
              `Subcommands: /wafer zdr [on|off] · refresh · models · usage · hide`,
            "info",
          );
        }
      }
    },
  });
}
