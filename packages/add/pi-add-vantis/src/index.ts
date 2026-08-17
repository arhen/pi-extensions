/**
 * Vantis Cards provider for pi.
 *
 * - Login: `/login` → "Vantis Cards" → paste API key (stored in pi's auth.json),
 *   or set VANTIS_CARD_API_KEY / VANTIS_CARD_KEY env var.
 * - Models: fetched live from `GET https://card.vantis.sh/v1/models` (public
 *   endpoint, no key needed; refreshable), mapped with context window, gateway
 *   max output (32,768 for every model), cost, and deepseek-style reasoning
 *   (`thinking: {type}` + `reasoning_effort`, reasoning_content preserved on
 *   replayed assistant messages).
 * - Status: pi's built-in footer shows session totals from message usage +
 *   per-model cost; `/vantis balance` shows the key's lane balance.
 *
 * Commands:
 *   /vantis           status summary (key, model count)
 *   /vantis zdr [on|off]   toggle Zero Data Retention (re-registers + refetches
 *                         catalog; sends `X-ZDR: required` on every request;
 *   honored responses carry `X-Vantis-ZDR: honored`; footer status shows
 *   `ZDR✓` once attested, plus the live billing tier from `X-Vantis-Tier`
 *   (fast/standard) on chat responses)
 *   /vantis refresh   force-refetch model catalog
 *   /vantis models    list models with configs (widget below editor)
 *   /vantis balance   key lane balance + $VANTIS conversion
 *   /vantis hide      clear the models widget
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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const BASE = "https://card.vantis.sh/v1";
// vantis's WAF blocks the OpenAI SDK user-agent (403 "Your request was blocked."
// for `OpenAI/JS *` / `OpenAI/Python *`); pi sends OpenAI/JS via openai-node.
// Override with a neutral UA on every request (model headers merge into the
// SDK's defaultHeaders, which win over its own UA).
const USER_AGENT = "pi/1.0";
// Gateway caps output at 32,768 tokens per call on every model (docs: chat-completions).
const MAX_OUTPUT = 32768;
// DeepSeek reasoning_effort: low|medium|high. pi's xhigh is capped at high.
const THINKING_MAP = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
};

interface VantisCatalogModel {
	id: string;
	context_window?: number;
	family?: string;
}
interface VantisPricing {
	model: string;
	label?: string;
	family?: "open" | "frontier";
	usd_per_1m_input?: number;
	usd_per_1m_output?: number;
	context_window?: number;
}
interface VantisCatalog {
	data?: VantisCatalogModel[];
	pricing?: VantisPricing[];
}

type MappedModel = ProviderModelConfig & {
	provider: string;
	baseUrl: string;
	api: "openai-completions";
};

const stateFile = join(getAgentDir(), "vantis.json");
let zdrOn = false;
let zdrHonored = false; // set from X-Vantis-ZDR: honored on a live response (not persisted)
let lastTier: string | undefined; // from X-Vantis-Tier on a live response (not persisted)
let lastBalanceUsd = 0;
let lastBalanceFetched = 0;

async function loadState() {
	try {
		const s = JSON.parse(await readFile(stateFile, "utf8"));
		zdrOn = s.zdr === true;
		lastBalanceUsd = s.balanceUsd ?? 0;
		lastBalanceFetched = s.balanceAt ?? 0;
	} catch {
		zdrOn = false;
	}
}
async function saveState() {
	await mkdir(dirname(stateFile), { recursive: true });
	await writeFile(
		stateFile,
		JSON.stringify({
			zdr: zdrOn,
			balanceUsd: lastBalanceUsd,
			balanceAt: lastBalanceFetched,
		}),
	);
}

function mapModel(
	m: VantisCatalogModel,
	p: VantisPricing | undefined,
): MappedModel {
	const family = p?.family ?? m.family;
	return {
		id: m.id,
		name: p?.label ?? m.id,
		api: "openai-completions",
		provider: "vantis",
		baseUrl: BASE,
		headers: { "User-Agent": USER_AGENT },
		// reasoning_content documented for the DeepSeek route; frontier ids are
		// allowlist-only and most keys get 403 anyway.
		reasoning: family === "open",
		thinkingLevelMap: THINKING_MAP,
		input: ["text"],
		cost: {
			// cache billed at input price (docs: OpenClaw integration config)
			input: (p?.usd_per_1m_input ?? 0) / 1_000_000,
			output: (p?.usd_per_1m_output ?? 0) / 1_000_000,
			cacheRead: (p?.usd_per_1m_input ?? 0) / 1_000_000,
			cacheWrite: (p?.usd_per_1m_input ?? 0) / 1_000_000,
		},
		contextWindow: m.context_window ?? p?.context_window ?? 1_048_576,
		maxTokens: MAX_OUTPUT,
		compat: {
			thinkingFormat: "deepseek",
			requiresReasoningContentOnAssistantMessages: true,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
		},
	};
}

async function refreshModels(
	context: RefreshModelsContext,
): Promise<ProviderModelConfig[]> {
	if (context.allowNetwork === false)
		return [...(context.stored?.models ?? [])];
	const headers: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": USER_AGENT,
	};
	const key = context.credential?.key ?? vantisKey();
	if (key) headers.Authorization = `Bearer ${key}`;
	if (context.stored?.etag) headers["If-None-Match"] = context.stored.etag;
	let res: Response;
	try {
		res = await fetch(`${BASE}/models`, { headers, signal: context.signal });
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
			`[vantis] models fetch failed: ${res.status} ${res.statusText}`,
		);
		return [...(context.stored?.models ?? [])];
	}
	const data = (await res.json()) as VantisCatalog;
	const byId = new Map((data.pricing ?? []).map((p) => [p.model, p]));
	const models = (data.data ?? []).map((m) => mapModel(m, byId.get(m.id)));
	const lastModified =
		Date.parse(res.headers.get("last-modified") ?? "") || undefined;
	await context.publish({
		persist: {
			models,
			etag: res.headers.get("etag") ?? undefined,
			lastModified,
			checkedAt: Date.now(),
		},
	});
	return models;
}

function vantisKey(): string | undefined {
	const cred = readStoredCredential("vantis");
	return (
		(cred?.type === "api_key" ? cred.key : undefined) ??
		process.env.VANTIS_CARD_API_KEY ??
		process.env.VANTIS_CARD_KEY
	);
}

const fmtTokens = (n: number) =>
	n >= 1_000_000
		? `${(n / 1_000_000).toFixed(1)}M`
		: n >= 1_000
			? `${(n / 1_000).toFixed(1)}k`
			: `${n}`;

export default async function (pi: ExtensionAPI) {
	await loadState();

	const registerProvider = () => {
		const config: ProviderConfig = {
			name: "Vantis Cards",
			baseUrl: BASE,
			api: "openai-completions",
			apiKey: "$VANTIS_CARD_API_KEY",
			authHeader: true,
			// docs (security): ZDR route is requested via `zdr: true` body or
			// `X-ZDR: required` header; attested by `X-Vantis-ZDR: honored` response.
			headers: {
				"User-Agent": USER_AGENT,
				...(zdrOn ? { "X-ZDR": "required" } : {}),
			},
			refreshModels,
		};
		pi.registerProvider("vantis", config);
	};
	registerProvider();

	const statusText = () => {
		// balance removed: redundant with pi's built-in session cost
		const parts: string[] = [];
		if (zdrOn) parts.push(zdrHonored ? "ZDR✓" : "ZDR");
		if (lastTier) parts.push(lastTier);
		return parts.join(" · ");
	};

	// Footer status only while a vantis model is active.
	const syncStatus = (ctx: { ui: { setStatus(k: string, v: string | undefined): void } }, model?: { provider?: string }) => {
		ctx.ui.setStatus("vantis", model?.provider === "vantis" ? statusText() || undefined : undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		syncStatus(ctx, ctx.model);
		// Catalog endpoint is public — always refresh (offline-safe via stored fallback).
		void ctx.modelRegistry.refresh({ providers: ["vantis"] }).catch(() => {});
	});

	pi.on("model_select", (event, ctx) => {
		syncStatus(ctx, event.model);
	});

	// Header detection: X-Vantis-Tier (fast/standard billing tier) and
	// X-Vantis-ZDR: honored (ZDR attestation) on live chat responses.
	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider !== "vantis") return;
		const get = (k: string) =>
			Object.entries(event.headers).find(
				([key]) => key.toLowerCase() === k,
			)?.[1];
		const tier = get("x-vantis-tier");
		if (tier) lastTier = tier;
		const zdr = get("x-vantis-zdr");
		if (zdr) zdrHonored = zdr.toLowerCase() === "honored";
		syncStatus(ctx, ctx.model);
	});

	type Ctx = {
		modelRegistry: {
			refresh(opts: { providers: string[]; force?: boolean }): Promise<unknown>;
		};
		ui: { notify(msg: string, kind?: string): void };
		model?: { provider?: string };
	};
	const toggleZdr = async (
		ctx: Ctx,
		next?: boolean,
		requireVantis = false,
	) => {
		if (requireVantis && ctx.model?.provider !== "vantis") {
			ctx.ui.notify(
				"Vantis ZDR: not on a vantis model (ctrl+shift+z applies to vantis only)",
				"warning",
			);
			return;
		}
		zdrOn = next ?? !zdrOn;
		zdrHonored = false; // pending until a live response attests X-Vantis-ZDR: honored
		await saveState();
		registerProvider(); // re-register with new ZDR header (keeps existing models)
		await ctx.modelRegistry.refresh({ providers: ["vantis"], force: true });
		syncStatus(ctx, ctx.model);
		ctx.ui.notify(
			`Vantis ZDR ${zdrOn ? "ON" : "off"} — ${zdrOn ? "requests send X-ZDR: required; honored responses carry X-Vantis-ZDR: honored, calls fail if ZDR capacity unavailable" : "requests may use non-ZDR routes"}`,
			zdrOn ? "warning" : "info",
		);
	};

	pi.registerShortcut("ctrl+shift+z", {
		description: "Toggle Vantis ZDR (when on a vantis model)",
		handler: async (ctx) => {
			await toggleZdr(ctx, undefined, true);
		},
	});

	pi.registerCommand("vantis", {
		description:
			"Vantis cards: status / zdr [on|off] / refresh / models / balance / hide",
		handler: async (args, ctx) => {
			const [cmd, ...rest] = (args ?? "").trim().split(/\s+/);
			switch (cmd) {
				case "zdr": {
					const next =
						rest[0] === "on" ? true : rest[0] === "off" ? false : undefined;
					await toggleZdr(ctx, next);
					return;
				}
				case "refresh": {
					ctx.ui.notify("Refreshing Vantis model catalog…", "info");
					await ctx.modelRegistry.refresh({
						providers: ["vantis"],
						force: true,
					});
					const n =
						ctx.modelRegistry.getProvider("vantis")?.getModels().length ?? 0;
					ctx.ui.notify(`Vantis catalog refreshed: ${n} models`, "info");
					return;
				}
				case "models": {
					const models =
						ctx.modelRegistry.getProvider("vantis")?.getModels() ?? [];
					const lines = [
						"Vantis models — ctx / max out / reasoning / family / tier:",
					];
					for (const m of models) {
						const family = m.reasoning ? "open" : "frontier(allowlist)";
						const tier = m.id.endsWith("-fast") ? "fast" : "standard";
						lines.push(
							`${m.id}  ctx=${fmtTokens(m.contextWindow)}  out=${fmtTokens(m.maxTokens)}  ` +
								`reasoning=${m.reasoning ? "on" : "off"}  ${family}  tier=${tier}`,
						);
					}
					if (models.length === 0) lines.push("(no models — /vantis refresh)");
					ctx.ui.setWidget("vantis-models", lines, {
						placement: "belowEditor",
					});
					ctx.ui.notify(
						`Vantis: ${models.length} models (listed below editor, /vantis hide to clear)`,
						"info",
					);
					return;
				}
				case "hide": {
					ctx.ui.setWidget("vantis-models", undefined);
					return;
				}
				case "balance": {
					const key = vantisKey();
					if (!key) {
						ctx.ui.notify(
							"Vantis not logged in. Run /login → Vantis Cards, or set VANTIS_CARD_API_KEY.",
							"warning",
						);
						return;
					}
					ctx.ui.notify("Fetching Vantis balance…", "info");
					try {
						const res = await fetch(`${BASE}/balance`, {
							headers: {
								Authorization: `Bearer ${key}`,
								"User-Agent": USER_AGENT,
							},
						});
						if (!res.ok) {
							ctx.ui.notify(
								`Vantis balance failed: ${res.status} ${res.statusText}`,
								"warning",
							);
							return;
						}
						const b = (await res.json()) as Record<string, unknown>;
						lastBalanceUsd = (b.balance_usd as number) ?? lastBalanceUsd;
						lastBalanceFetched = Date.now();
						await saveState();
						syncStatus(ctx, ctx.model);
						const parts = Object.entries(b)
							.filter(([, v]) => typeof v !== "object" && v !== null)
							.map(([k, v]) => `${k}=${v}`);
						ctx.ui.notify(`Vantis balance: ${parts.join(" · ")}`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Vantis balance request failed: ${(err as Error).message}`,
							"warning",
						);
					}
					return;
				}
				default: {
					const key = vantisKey();
					const n =
						ctx.modelRegistry.getProvider("vantis")?.getModels().length ?? 0;
					ctx.ui.notify(
						`Vantis: ${key ? "logged in" : "no key (/login → Vantis Cards or VANTIS_CARD_API_KEY)"} · ` +
							`${n} models · ZDR ${zdrOn ? "on" : "off"}\n` +
							`Subcommands: /vantis zdr [on|off] · refresh · models · balance · hide`,
						"info",
					);
				}
			}
		},
	});
}
