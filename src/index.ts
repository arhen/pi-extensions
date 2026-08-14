/**
 * pi-9router — minimal 9router provider extension for Pi.
 *
 * Registers 9router as a Pi provider (models, combos, reasoning) with config
 * flow. No web tools — use pi-web-access / pi-9router-ext for those.
 *
 * Env overrides:
 *   NINE_ROUTER_BASE_URL         - default: http://localhost:20128
 *   NINE_ROUTER_API_KEY          - API key if 9router requires auth
 *   NINE_ROUTER_ENABLE_REASONING - expose thinking levels + reasoning_effort
 *
 * Config file: ~/.pi/agent/9router-config.json
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// =============================================================================
// Types
// =============================================================================

interface NineRouterConfig {
	baseUrl: string;
	apiKey: string | undefined;
	enableReasoning: boolean;
}

interface NineRouterModel {
	id: string;
	object: string;
	owned_by?: string;
	kind?: string;
	contextWindow?: unknown;
	context_window?: unknown;
	contextLength?: unknown;
	context_length?: unknown;
	maxTokens?: unknown;
	max_tokens?: unknown;
	maxOutputTokens?: unknown;
	max_output_tokens?: unknown;
	maxCompletionTokens?: unknown;
	max_completion_tokens?: unknown;
	metadata?: Record<string, unknown>;
	limits?: Record<string, unknown>;
	capabilities?: Record<string, unknown>;
	top_provider?: Record<string, unknown>;
	[key: string]: unknown;
}

interface NineRouterModelsResponse {
	object: string;
	data: NineRouterModel[];
}

interface ModelMetadata {
	id: string;
	name?: string;
	reasoning?: unknown;
	modalities?: { input?: unknown; output?: unknown };
	limit?: { context?: unknown; output?: unknown };
	cost?: Record<string, unknown>;
	[key: string]: unknown;
}

type ModelMetadataApi = Record<
	string,
	{ models?: Record<string, ModelMetadata> }
>;
type ModelMetadataIndex = Map<string, ModelMetadata>;
type DiscoveryStatus =
	| "idle"
	| "discovering"
	| "connected"
	| "not_configured"
	| "disconnected";

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_BASE_URL = "http://localhost:20128";
const ENV_BASE_URL = process.env.NINE_ROUTER_BASE_URL;
const ENV_API_KEY = process.env.NINE_ROUTER_API_KEY;
const ENV_ENABLE_REASONING = process.env.NINE_ROUTER_ENABLE_REASONING;
const CONFIG_PATH = join(homedir(), ".pi", "agent", "9router-config.json");
const CACHE_DIR = join(
	process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
	"pi",
);
const MODEL_METADATA_CACHE_PATH = join(
	CACHE_DIR,
	"9router-model-metadata.json",
);
const DISCOVERY_CACHE_PATH = join(CACHE_DIR, "9router-discovery-cache.json");
const MODEL_METADATA_URL = "https://models.dev/api.json";
const MODEL_METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const STARTUP_DISCOVERY_TIMEOUT_MS = 5_000;

const CUSTOM_TYPE_CONFIG = "9router-config";
const FALLBACK_CONTEXT_WINDOW = 128000;
const FALLBACK_MAX_TOKENS = 4096;

// Some models advertise huge context but cap completions lower (e.g. MiMo ~1M
// ctx / 131072 out). Clamp or the client sends max_tokens above upstream cap.
const MIMO_MAX_COMPLETION_TOKENS = 131072;

// =============================================================================
// Config Helpers
// =============================================================================

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/$/, "");
}

function maskApiKey(key: string): string {
	if (key.length <= 8) return "●".repeat(key.length);
	return (
		key.slice(0, 4) + "●".repeat(Math.max(0, key.length - 8)) + key.slice(-4)
	);
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
	if (["0", "false", "no", "off", "disabled"].includes(normalized))
		return false;
	return undefined;
}

function applyEnvOverrides(config: NineRouterConfig): NineRouterConfig {
	return {
		baseUrl: normalizeBaseUrl(ENV_BASE_URL || config.baseUrl),
		apiKey: ENV_API_KEY || config.apiKey,
		enableReasoning:
			parseBooleanFlag(ENV_ENABLE_REASONING) ?? config.enableReasoning,
	};
}

function loadConfigFromDisk(): NineRouterConfig | null {
	try {
		if (!existsSync(CONFIG_PATH)) return null;
		const data = JSON.parse(
			readFileSync(CONFIG_PATH, "utf8"),
		) as Partial<NineRouterConfig>;
		if (!data.baseUrl || typeof data.baseUrl !== "string") return null;
		return {
			baseUrl: normalizeBaseUrl(data.baseUrl),
			apiKey:
				typeof data.apiKey === "string" && data.apiKey.trim()
					? data.apiKey.trim()
					: undefined,
			enableReasoning: data.enableReasoning === true,
		};
	} catch (err) {
		console.error("[pi-9router] Failed to load persisted config:", err);
		return null;
	}
}

function saveConfigToDisk(config: NineRouterConfig) {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(
			CONFIG_PATH,
			`${JSON.stringify(
				{
					baseUrl: config.baseUrl,
					apiKey: config.apiKey,
					enableReasoning: config.enableReasoning,
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
	} catch (err) {
		console.error("[pi-9router] Failed to persist config:", err);
	}
}

function getInitialConfig(): NineRouterConfig {
	return applyEnvOverrides(
		loadConfigFromDisk() || {
			baseUrl: DEFAULT_BASE_URL,
			apiKey: undefined,
			enableReasoning: false,
		},
	);
}

function loadConfigFromSession(ctx: ExtensionContext): NineRouterConfig | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE_CONFIG) {
			const data = entry.data as Partial<NineRouterConfig> | undefined;
			if (data?.baseUrl) {
				return applyEnvOverrides({
					baseUrl: normalizeBaseUrl(data.baseUrl),
					apiKey: data.apiKey,
					enableReasoning: data.enableReasoning === true,
				});
			}
		}
	}
	return null;
}

function persistConfig(pi: ExtensionAPI, config: NineRouterConfig) {
	saveConfigToDisk(config);
	pi.appendEntry(CUSTOM_TYPE_CONFIG, {
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		enableReasoning: config.enableReasoning,
	});
}

// =============================================================================
// Discovery Cache
// =============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCachedModel(value: unknown): value is NineRouterModel {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		value.id.trim().length > 0
	);
}

function apiKeyHash(apiKey: string | undefined): string {
	return apiKey
		? `sha256:${createHash("sha256").update(apiKey).digest("hex")}`
		: "none";
}

function cacheMatchesConfig(
	cache: Partial<NineRouterDiscoveryCache>,
	config: NineRouterConfig,
): boolean {
	if (normalizeBaseUrl(String(cache.baseUrl || "")) !== config.baseUrl)
		return false;
	// Legacy caches without credential fingerprint: trust only unauthenticated.
	if (typeof cache.apiKeyHash !== "string") return !config.apiKey;
	return cache.apiKeyHash === apiKeyHash(config.apiKey);
}

interface NineRouterDiscoveryCache {
	baseUrl: string;
	apiKeyHash?: string;
	ts: number;
	models: NineRouterModel[];
}

function readDiscoveryCache(
	config: NineRouterConfig,
): NineRouterDiscoveryCache | undefined {
	try {
		if (!existsSync(DISCOVERY_CACHE_PATH)) return undefined;
		const cache = JSON.parse(
			readFileSync(DISCOVERY_CACHE_PATH, "utf8"),
		) as Partial<NineRouterDiscoveryCache>;
		if (!cacheMatchesConfig(cache, config)) return undefined;
		if (!Array.isArray(cache.models) || cache.models.length === 0)
			return undefined;
		return {
			baseUrl: config.baseUrl,
			apiKeyHash: apiKeyHash(config.apiKey),
			ts: typeof cache.ts === "number" ? cache.ts : 0,
			models: cache.models.filter(isCachedModel),
		};
	} catch (err) {
		console.warn(
			`[pi-9router] Failed to load discovery cache: ${errorMessage(err)}`,
		);
		return undefined;
	}
}

function writeDiscoveryCache(
	config: NineRouterConfig,
	models: NineRouterModel[],
) {
	if (models.length === 0) return;
	try {
		mkdirSync(dirname(DISCOVERY_CACHE_PATH), { recursive: true });
		writeFileSync(
			DISCOVERY_CACHE_PATH,
			`${JSON.stringify(
				{
					baseUrl: config.baseUrl,
					apiKeyHash: apiKeyHash(config.apiKey),
					ts: Date.now(),
					models,
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
	} catch (err) {
		console.warn(
			`[pi-9router] Failed to persist discovery cache: ${errorMessage(err)}`,
		);
	}
}

function clearDiscoveryCache(config: NineRouterConfig) {
	try {
		if (!existsSync(DISCOVERY_CACHE_PATH)) return;
		const cache = JSON.parse(
			readFileSync(DISCOVERY_CACHE_PATH, "utf8"),
		) as Partial<NineRouterDiscoveryCache>;
		if (cacheMatchesConfig(cache, config)) {
			unlinkSync(DISCOVERY_CACHE_PATH);
		}
	} catch (err) {
		console.warn(
			`[pi-9router] Failed to clear discovery cache: ${errorMessage(err)}`,
		);
	}
}

// =============================================================================
// Fetch Helpers
// =============================================================================

function createTimeoutSignal(
	signal: AbortSignal | undefined,
	timeoutMs: number,
) {
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timer = setTimeout(abort, timeoutMs);
	timer.unref?.();

	if (signal?.aborted) {
		abort();
	} else {
		signal?.addEventListener("abort", abort, { once: true });
	}

	return {
		signal: controller.signal,
		cleanup() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		},
	};
}

async function fetchWithTimedBody<T>(
	url: string,
	init: RequestInit = {},
	signal: AbortSignal | undefined,
	timeoutMs: number,
	consume: (response: Response) => Promise<T>,
): Promise<T> {
	const timeout = createTimeoutSignal(signal, timeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: timeout.signal });
		return await consume(response);
	} finally {
		timeout.cleanup();
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAuthError(err: unknown): boolean {
	const message = errorMessage(err).toLowerCase();
	return (
		message.includes("401") ||
		message.includes("403") ||
		message.includes("unauthorized") ||
		message.includes("forbidden") ||
		message.includes("api key") ||
		message.includes("auth")
	);
}

function connectionFailureStatus(err: unknown): DiscoveryStatus {
	return isAuthError(err) ? "not_configured" : "disconnected";
}

function conciseConnectionMessage(err: unknown): string {
	const message = errorMessage(err);
	if (isAuthError(err)) return `auth required (${message})`;
	return message;
}

function staleDiscoveryError(): Error {
	const err = new Error("stale discovery result");
	err.name = "StaleDiscoveryError";
	return err;
}

function isStaleDiscoveryError(err: unknown): boolean {
	return err instanceof Error && err.name === "StaleDiscoveryError";
}

// =============================================================================
// Model Metadata (models.dev enrichment for context window / limits)
// =============================================================================

function readMetadataCache(): { ts: number; data: unknown } | undefined {
	try {
		if (!existsSync(MODEL_METADATA_CACHE_PATH)) return undefined;
		const cache = JSON.parse(
			readFileSync(MODEL_METADATA_CACHE_PATH, "utf8"),
		) as { ts?: unknown; data?: unknown };
		if (typeof cache.ts !== "number") return undefined;
		return { ts: cache.ts, data: cache.data };
	} catch {
		return undefined;
	}
}

function writeMetadataCache(data: unknown) {
	try {
		mkdirSync(dirname(MODEL_METADATA_CACHE_PATH), { recursive: true });
		writeFileSync(
			MODEL_METADATA_CACHE_PATH,
			JSON.stringify({ ts: Date.now(), data }),
			{ mode: 0o600 },
		);
	} catch (err) {
		console.error("[pi-9router] Failed to persist model metadata cache:", err);
	}
}

function normalizeModelId(id: string): string {
	return id
		.toLowerCase()
		.replace(/:(free)$/i, "")
		.replace(/-\d{8}$/, "");
}

function hasColonNamespace(id: string): boolean {
	const colon = id.indexOf(":");
	if (colon < 0) return false;
	const slash = id.indexOf("/");
	return slash < 0 || colon < slash;
}

function stripModelPrefix(id: string): string {
	const slash = id.lastIndexOf("/");
	return slash >= 0 ? id.slice(slash + 1) : id;
}

function stripModelPrefixForLookup(id: string): string {
	return hasColonNamespace(id) ? id : stripModelPrefix(id);
}

function addMetadataIndexEntry(
	index: ModelMetadataIndex,
	key: string,
	model: ModelMetadata,
) {
	if (!key) return;
	if (!index.has(key)) index.set(key, model);
	const normalized = normalizeModelId(key);
	if (!index.has(normalized)) index.set(normalized, model);
}

function buildModelMetadataIndex(api: ModelMetadataApi): ModelMetadataIndex {
	const index: ModelMetadataIndex = new Map();
	for (const provider of Object.values(api)) {
		if (!provider?.models) continue;
		for (const [modelId, model] of Object.entries(provider.models)) {
			const indexedModel = { ...model, id: model.id || modelId };
			addMetadataIndexEntry(index, modelId, indexedModel);
			addMetadataIndexEntry(index, indexedModel.id, indexedModel);
			addMetadataIndexEntry(
				index,
				stripModelPrefixForLookup(modelId),
				indexedModel,
			);
			addMetadataIndexEntry(
				index,
				stripModelPrefixForLookup(indexedModel.id),
				indexedModel,
			);
		}
	}
	return index;
}

function lookupModelMetadata(
	id: string,
	index: ModelMetadataIndex,
): ModelMetadata | undefined {
	const stripped = stripModelPrefixForLookup(id);
	const candidates = [
		id,
		stripped,
		normalizeModelId(id),
		normalizeModelId(stripped),
	];
	for (const candidate of candidates) {
		const match = index.get(candidate);
		if (match) return match;
	}

	const normalized = normalizeModelId(stripped);
	for (const [key, model] of index) {
		const normalizedKey = normalizeModelId(key);
		if (
			normalizedKey.startsWith(normalized) ||
			normalized.startsWith(normalizedKey)
		) {
			return model;
		}
	}
	return undefined;
}

function readCachedModelMetadataIndex(): ModelMetadataIndex {
	const cached = readMetadataCache();
	return cached
		? buildModelMetadataIndex((cached.data as ModelMetadataApi) || {})
		: new Map();
}

async function fetchModelMetadataIndex(
	signal?: AbortSignal,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ModelMetadataIndex> {
	const cached = readMetadataCache();
	if (cached && Date.now() - cached.ts < MODEL_METADATA_TTL_MS) {
		return buildModelMetadataIndex((cached.data as ModelMetadataApi) || {});
	}

	try {
		const payload = await fetchWithTimedBody(
			MODEL_METADATA_URL,
			{ method: "GET", headers: { Accept: "application/json" } },
			signal,
			timeoutMs,
			async (response) => {
				if (!response.ok)
					throw new Error(`HTTP ${response.status}: ${response.statusText}`);
				return (await response.json()) as ModelMetadataApi;
			},
		);
		writeMetadataCache(payload);
		return buildModelMetadataIndex(payload);
	} catch (err) {
		if (cached) {
			console.warn(
				`[pi-9router] Failed to refresh model metadata, using stale cache: ${errorMessage(err)}`,
			);
			return buildModelMetadataIndex((cached.data as ModelMetadataApi) || {});
		}
		console.warn(
			`[pi-9router] Failed to fetch model metadata: ${errorMessage(err)}`,
		);
		return new Map();
	}
}

// =============================================================================
// 9router API Client
// =============================================================================

async function fetchModels(
	config: NineRouterConfig,
	signal?: AbortSignal,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<NineRouterModel[]> {
	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (config.apiKey) {
		headers.Authorization = `Bearer ${config.apiKey}`;
	}

	return await fetchWithTimedBody(
		`${config.baseUrl}/v1/models`,
		{
			method: "GET",
			headers,
		},
		signal,
		timeoutMs,
		async (response) => {
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(
					`9router returned ${response.status}: ${text || response.statusText}`,
				);
			}
			const payload = (await response.json()) as NineRouterModelsResponse;
			return payload.data || [];
		},
	);
}

async function testConnection(
	config: NineRouterConfig,
	signal?: AbortSignal,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const headers: Record<string, string> = {};
		if (config.apiKey) {
			headers.Authorization = `Bearer ${config.apiKey}`;
		}
		return await fetchWithTimedBody(
			`${config.baseUrl}/v1/models`,
			{ method: "GET", headers },
			signal,
			timeoutMs,
			async (response) => {
				const text = await response.text().catch(() => "");
				if (response.ok) return { ok: true };
				return {
					ok: false,
					error: `HTTP ${response.status}: ${text || response.statusText}`,
				};
			},
		);
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// =============================================================================
// Model Mapping
// =============================================================================

function parseTokenCount(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	if (typeof value !== "string") return undefined;

	const normalized = value.trim().replace(/,/g, "").toLowerCase();
	const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/);
	if (!match) return undefined;

	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const multiplier =
		match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
	return Math.floor(amount * multiplier);
}

function readPath(
	record: Record<string, unknown>,
	path: readonly string[],
): unknown {
	let current: unknown = record;
	for (const segment of path) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function firstTokenCount(
	record: Record<string, unknown>,
	paths: readonly (readonly string[])[],
): number | undefined {
	for (const path of paths) {
		const value = readPath(record, path);
		const parsed = parseTokenCount(value);
		if (parsed !== undefined) return parsed;
	}
	return undefined;
}

type LimitSource = "router" | "metadata" | "fallback";

interface LimitInfo {
	value: number;
	source: LimitSource;
}

const ROUTER_CONTEXT_PATHS = [
	["contextWindow"],
	["context_window"],
	["contextLength"],
	["context_length"],
	["maxContextWindow"],
	["max_context_window"],
	["maxContextLength"],
	["max_context_length"],
	["maxInputTokens"],
	["max_input_tokens"],
	["maxModelLen"],
	["max_model_len"],
	["inputTokenLimit"],
	["input_token_limit"],
	["totalTokenLimit"],
	["total_token_limit"],
	["tokenLimit"],
	["token_limit"],
	["n_ctx"],
	["ctx_size"],
	["top_provider", "context_length"],
	["metadata", "contextWindow"],
	["metadata", "context_window"],
	["metadata", "context_length"],
	["metadata", "maxInputTokens"],
	["metadata", "max_input_tokens"],
	["metadata", "maxModelLen"],
	["metadata", "max_model_len"],
	["limits", "contextWindow"],
	["limits", "context_window"],
	["limits", "context_length"],
	["limits", "maxInputTokens"],
	["limits", "max_input_tokens"],
	["limits", "maxModelLen"],
	["limits", "max_model_len"],
	["capabilities", "contextWindow"],
	["capabilities", "context_window"],
	["capabilities", "context_length"],
	["capabilities", "maxInputTokens"],
	["capabilities", "max_input_tokens"],
	["capabilities", "maxModelLen"],
	["capabilities", "max_model_len"],
] as const;

const ROUTER_OUTPUT_PATHS = [
	["maxOutputTokens"],
	["max_output_tokens"],
	["maxCompletionTokens"],
	["max_completion_tokens"],
	["outputTokenLimit"],
	["output_token_limit"],
	["maxNewTokens"],
	["max_new_tokens"],
	["n_predict"],
	["top_provider", "max_completion_tokens"],
	["metadata", "maxOutputTokens"],
	["metadata", "max_output_tokens"],
	["metadata", "maxCompletionTokens"],
	["metadata", "max_completion_tokens"],
	["metadata", "maxNewTokens"],
	["metadata", "max_new_tokens"],
	["limits", "maxOutputTokens"],
	["limits", "max_output_tokens"],
	["limits", "maxCompletionTokens"],
	["limits", "max_completion_tokens"],
	["limits", "maxNewTokens"],
	["limits", "max_new_tokens"],
	["capabilities", "maxOutputTokens"],
	["capabilities", "max_output_tokens"],
	["capabilities", "maxCompletionTokens"],
	["capabilities", "max_completion_tokens"],
	["capabilities", "maxNewTokens"],
	["capabilities", "max_new_tokens"],
	["maxTokens"],
	["max_tokens"],
	["metadata", "maxTokens"],
	["metadata", "max_tokens"],
	["limits", "maxTokens"],
	["limits", "max_tokens"],
	["capabilities", "maxTokens"],
	["capabilities", "max_tokens"],
] as const;

const METADATA_CONTEXT_PATHS = [
	["limit", "context"],
	["limits", "context"],
	["contextWindow"],
	["context_window"],
	["contextLength"],
	["context_length"],
	["maxInputTokens"],
	["max_input_tokens"],
] as const;

const METADATA_OUTPUT_PATHS = [
	["limit", "output"],
	["limits", "output"],
	["maxOutputTokens"],
	["max_output_tokens"],
	["maxCompletionTokens"],
	["max_completion_tokens"],
	["maxTokens"],
	["max_tokens"],
] as const;

function isMimoModel(model: NineRouterModel): boolean {
	const id = (model.id || "").toLowerCase();
	return id.includes("mimo");
}

function modelContextWindowInfo(
	model: NineRouterModel,
	metadata?: ModelMetadata,
): LimitInfo {
	const routerValue = firstTokenCount(model, ROUTER_CONTEXT_PATHS);
	if (routerValue !== undefined)
		return { value: routerValue, source: "router" };

	const metadataValue = metadata
		? firstTokenCount(metadata, METADATA_CONTEXT_PATHS)
		: undefined;
	if (metadataValue !== undefined)
		return { value: metadataValue, source: "metadata" };

	return { value: FALLBACK_CONTEXT_WINDOW, source: "fallback" };
}

function modelMaxTokensInfo(
	model: NineRouterModel,
	metadata: ModelMetadata | undefined,
	contextWindow: number,
): LimitInfo {
	const modelMaxCap = isMimoModel(model)
		? MIMO_MAX_COMPLETION_TOKENS
		: Infinity;

	const routerValue = firstTokenCount(model, ROUTER_OUTPUT_PATHS);
	if (routerValue !== undefined)
		return {
			value: Math.min(routerValue, contextWindow, modelMaxCap),
			source: "router",
		};

	const metadataValue = metadata
		? firstTokenCount(metadata, METADATA_OUTPUT_PATHS)
		: undefined;
	if (metadataValue !== undefined)
		return {
			value: Math.min(metadataValue, contextWindow, modelMaxCap),
			source: "metadata",
		};

	return {
		value: Math.min(FALLBACK_MAX_TOKENS, contextWindow, modelMaxCap),
		source: "fallback",
	};
}

function modelContextWindow(
	model: NineRouterModel,
	metadata?: ModelMetadata,
): number {
	return modelContextWindowInfo(model, metadata).value;
}

function modelMaxTokens(
	model: NineRouterModel,
	metadata?: ModelMetadata,
	contextWindow = modelContextWindow(model, metadata),
): number {
	return modelMaxTokensInfo(model, metadata, contextWindow).value;
}

function modelInputTypes(metadata?: ModelMetadata): ("text" | "image")[] {
	const input = metadata?.modalities?.input;
	if (Array.isArray(input)) {
		const types = input.filter(
			(item): item is "text" | "image" => item === "text" || item === "image",
		);
		if (types.length > 0) return types;
	}
	return ["text"];
}

function formatTokenCount(tokens: number): string {
	return tokens >= 1000 && tokens % 1000 === 0
		? `${tokens / 1000}k`
		: String(tokens);
}

function modelLimitSummary(
	model: NineRouterModel,
	metadata?: ModelMetadata,
): string {
	const context = modelContextWindowInfo(model, metadata);
	const output = modelMaxTokensInfo(model, metadata, context.value);
	return `${formatTokenCount(context.value)} ctx / ${formatTokenCount(output.value)} out (${context.source}/${output.source})`;
}

function mapNineRouterModel(
	model: NineRouterModel,
	enableReasoning: boolean,
	metadata?: ModelMetadata,
) {
	const isCombo = model.owned_by === "combo";
	const contextWindow = modelContextWindow(model, metadata);
	const maxTokens = modelMaxTokens(model, metadata, contextWindow);

	return {
		id: model.id,
		name: isCombo ? `🔀 ${model.id}` : model.id,
		reasoning: enableReasoning,
		...(enableReasoning
			? {
					// Pi levels → 9router's OpenAI-style reasoning_effort. 9router does not
					// expose per-model reasoning from /v1/models, so this is user config.
					thinkingLevelMap: {
						off: "none",
						minimal: null,
						low: "low",
						medium: "medium",
						high: "high",
						xhigh: "xhigh",
					},
				}
			: {}),
		input: modelInputTypes(metadata),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: enableReasoning,
			maxTokensField: "max_tokens" as const,
			thinkingFormat: "openai" as const,
		},
	};
}

// =============================================================================
// Provider Registration
// =============================================================================

function registerNineRouterProvider(
	pi: ExtensionAPI,
	config: NineRouterConfig,
	models: NineRouterModel[],
	metadataIndex: ModelMetadataIndex,
) {
	// Dedicated provider id; never override built-ins like ollama-cloud.
	// Pi requires apiKey for custom providers — use placeholder when unset.
	pi.registerProvider("9router", {
		name: "9router",
		baseUrl: `${config.baseUrl}/v1`,
		apiKey: config.apiKey || "9router-no-api-key",
		api: "openai-completions",
		models: models.map((model) =>
			mapNineRouterModel(
				model,
				config.enableReasoning,
				lookupModelMetadata(model.id, metadataIndex),
			),
		),
	});
}

function unregisterNineRouterProvider(pi: ExtensionAPI) {
	pi.unregisterProvider("9router");
}

// =============================================================================
// Extension Factory
// =============================================================================

export default async function (pi: ExtensionAPI) {
	let config: NineRouterConfig = getInitialConfig();

	let discoveredModels: NineRouterModel[] = [];
	let modelMetadataIndex: ModelMetadataIndex = new Map();
	let isConnected = false;
	let discoveryStatus: DiscoveryStatus = "idle";
	let lastDiscoveryError: string | undefined;
	let isDiscovering = false;
	let providerRegistration:
		| { baseUrl: string; apiKey: string | undefined }
		| undefined;
	let discoveryGeneration = 0;

	function beginDiscovery() {
		discoveryGeneration += 1;
		isDiscovering = true;
		discoveryStatus = "discovering";
		return { generation: discoveryGeneration, config: { ...config } };
	}

	function setProviderRegistration(discoveryConfig: NineRouterConfig) {
		providerRegistration = {
			baseUrl: discoveryConfig.baseUrl,
			apiKey: discoveryConfig.apiKey,
		};
	}

	function isCurrentDiscovery(generation: number): boolean {
		return generation === discoveryGeneration;
	}

	function finishDiscovery(generation: number) {
		if (isCurrentDiscovery(generation)) {
			isDiscovering = false;
		}
	}

	function markDiscoveryFailure(
		err: unknown,
		context: string,
		generation: number,
	) {
		if (!isCurrentDiscovery(generation)) return;
		isConnected = false;
		discoveryStatus = connectionFailureStatus(err);
		lastDiscoveryError = conciseConnectionMessage(err);
		// Auth failures = credential known unusable. Non-auth failures keep the
		// previous provider only when baseUrl/apiKey identity did not change.
		const authFailure = isAuthError(err);
		const registrationChanged =
			!providerRegistration ||
			providerRegistration.baseUrl !== config.baseUrl ||
			providerRegistration.apiKey !== config.apiKey;
		if (authFailure || discoveredModels.length === 0 || registrationChanged) {
			unregisterNineRouterProvider(pi);
			providerRegistration = undefined;
			if (authFailure) {
				discoveredModels = [];
				modelMetadataIndex = new Map();
				clearDiscoveryCache(config);
			}
		}
		console.warn(`[pi-9router] ${context}: ${lastDiscoveryError}`);
	}

	async function refreshModels(
		discoveryConfig: NineRouterConfig,
		generation: number,
		signal?: AbortSignal,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<NineRouterModel[]> {
		try {
			const [models, metadataIndex] = await Promise.all([
				fetchModels(discoveryConfig, signal, timeoutMs),
				fetchModelMetadataIndex(signal, timeoutMs),
			]);
			if (models.length === 0) {
				throw new Error("no models returned by /v1/models");
			}
			if (!isCurrentDiscovery(generation)) {
				throw staleDiscoveryError();
			}
			discoveredModels = models;
			modelMetadataIndex = metadataIndex;
			isConnected = true;
			discoveryStatus = "connected";
			lastDiscoveryError = undefined;
			registerNineRouterProvider(
				pi,
				{ ...discoveryConfig, enableReasoning: config.enableReasoning },
				models,
				metadataIndex,
			);
			setProviderRegistration(discoveryConfig);
			writeDiscoveryCache(discoveryConfig, models);
			return models;
		} finally {
			finishDiscovery(generation);
		}
	}

	function startBackgroundDiscovery(reason: string) {
		const discovery = beginDiscovery();
		void (async () => {
			try {
				await refreshModels(
					discovery.config,
					discovery.generation,
					undefined,
					STARTUP_DISCOVERY_TIMEOUT_MS,
				);
			} catch (err) {
				if (isStaleDiscoveryError(err)) return;
				markDiscoveryFailure(
					err,
					`${reason} model discovery skipped`,
					discovery.generation,
				);
			}
		})();
	}

	function discoveryStatusLine(): string {
		if (isDiscovering) return "discovering";
		if (discoveryStatus === "connected") return "connected";
		if (discoveryStatus === "not_configured")
			return `not configured${lastDiscoveryError ? ` — ${lastDiscoveryError}` : ""}`;
		if (discoveryStatus === "disconnected")
			return `disconnected${lastDiscoveryError ? ` — ${lastDiscoveryError}` : ""}`;
		return "idle";
	}

	// ---------------------------------------------------------------------------
	// Startup: cached models first (fast), then background refresh
	// ---------------------------------------------------------------------------
	const cachedDiscovery = readDiscoveryCache(config);
	if (cachedDiscovery && cachedDiscovery.models.length > 0) {
		discoveredModels = cachedDiscovery.models;
		modelMetadataIndex = readCachedModelMetadataIndex();
		registerNineRouterProvider(
			pi,
			config,
			discoveredModels,
			modelMetadataIndex,
		);
		setProviderRegistration(config);
		startBackgroundDiscovery("startup");
	} else {
		const discovery = beginDiscovery();
		try {
			await refreshModels(
				discovery.config,
				discovery.generation,
				undefined,
				STARTUP_DISCOVERY_TIMEOUT_MS,
			);
		} catch (err) {
			if (!isStaleDiscoveryError(err)) {
				markDiscoveryFailure(
					err,
					"startup model discovery skipped",
					discovery.generation,
				);
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Session start: rehydrate config from session
	// ---------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const restored = loadConfigFromSession(ctx);
		if (!loadConfigFromDisk() && restored) {
			// Migrate old session-persisted config to user-wide config file.
			config = restored;
			persistConfig(pi, config);
			startBackgroundDiscovery("migrated config");
		}

		if (isConnected && discoveredModels.length > 0) {
			ctx.ui.notify(
				`9router connected — ${discoveredModels.length} models available`,
				"info",
			);
		} else if (isDiscovering) {
			ctx.ui.notify("9router discovery running in background", "info");
		} else {
			ctx.ui.notify(
				`9router ${discoveryStatusLine()} — use /9router-config to configure or /9router-reload to retry`,
				discoveryStatus === "not_configured" ? "warning" : "info",
			);
		}
	});

	// ---------------------------------------------------------------------------
	// Command: /9router-status
	// ---------------------------------------------------------------------------
	pi.registerCommand("9router-status", {
		description: "Show 9router connection status and configuration",
		handler: async (_args, ctx) => {
			const test = await testConnection(config, ctx.signal);
			const lines: string[] = [
				`🔗 9router Status`,
				``,
				`Base URL:    ${config.baseUrl}`,
				`API Key:     ${config.apiKey ? maskApiKey(config.apiKey) : "not set"}`,
				`Reasoning:   ${config.enableReasoning ? "enabled (manual)" : "disabled"}`,
				`Connection:  ${test.ok ? "🟢 connected" : `🔴 ${test.error || "disconnected"}`}`,
				`Discovery:   ${discoveryStatusLine()}`,
				`Models:      ${discoveredModels.length} available`,
				`Metadata:    ${modelMetadataIndex.size > 0 ? `${modelMetadataIndex.size} index keys cached` : "unavailable"}`,
			];

			const combos = discoveredModels.filter((m) => m.owned_by === "combo");
			const regular = discoveredModels.filter((m) => m.owned_by !== "combo");
			if (regular.length > 0) lines.push(`Regular models: ${regular.length}`);
			if (combos.length > 0) lines.push(`Combos:         ${combos.length}`);

			ctx.ui.notify(lines.join("\n"), test.ok ? "info" : "warning");
		},
	});

	// ---------------------------------------------------------------------------
	// Command: /9router-models
	// ---------------------------------------------------------------------------
	pi.registerCommand("9router-models", {
		description: "Browse 9router available models and combos",
		handler: async (_args, ctx) => {
			if (discoveredModels.length === 0) {
				ctx.ui.notify(
					"No 9router models discovered. Check connection with /9router-status",
					"warning",
				);
				return;
			}

			const items = discoveredModels.map((m) => {
				const isCombo = m.owned_by === "combo";
				const metadata = lookupModelMetadata(m.id, modelMetadataIndex);
				return {
					value: m.id,
					label: `${isCombo ? `🔀 ${m.id}` : m.id} (${modelLimitSummary(m, metadata)})`,
				};
			});

			const selected = await ctx.ui.select(
				"Select a 9router model to use:",
				items.map((i) => i.label),
			);
			if (!selected) return;

			const modelId = items.find((i) => i.label === selected)?.value;
			if (!modelId) return;

			const fullModelId = `9router/${modelId}`;
			ctx.ui.notify(`Switching to ${fullModelId}...`, "info");
			pi.sendUserMessage(`/model ${fullModelId}`, { deliverAs: "followUp" });
		},
	});

	// ---------------------------------------------------------------------------
	// Command: /9router-config
	// ---------------------------------------------------------------------------
	pi.registerCommand("9router-config", {
		description: "Configure 9router connection and reasoning",
		handler: async (_args, ctx) => {
			while (true) {
				const choice = await ctx.ui.select("9router configuration", [
					"Connection",
					"Reasoning",
					"View status",
					"Done",
				]);
				if (!choice || choice === "Done") return;

				if (choice === "Connection") {
					const test = await testConnection(config, ctx.signal);
					const currentLines = [
						"Current connection:",
						`  Base URL: ${config.baseUrl}`,
						`  API Key:  ${config.apiKey ? maskApiKey(config.apiKey) : "not set"}`,
						`  Status:   ${test.ok ? "🟢 connected" : `🔴 ${test.error || "disconnected"}`}`,
						"",
						"Enter new values (press Enter to keep current):",
					].join("\n");

					const newBaseUrl = await ctx.ui.input(currentLines, config.baseUrl);
					if (newBaseUrl === undefined) continue;

					const newApiKey = await ctx.ui.input(
						"API key (press Enter to keep current; type '-' to remove):",
						config.apiKey ? "current key hidden" : "API Key",
					);
					if (newApiKey === undefined) continue;

					const apiKeyInput = newApiKey.trim();
					config = {
						...config,
						baseUrl: normalizeBaseUrl(newBaseUrl.trim() || config.baseUrl),
						apiKey:
							apiKeyInput === "-" ? undefined : apiKeyInput || config.apiKey,
					};
					persistConfig(pi, config);

					const discovery = beginDiscovery();
					try {
						const models = await refreshModels(
							discovery.config,
							discovery.generation,
							ctx.signal,
						);
						ctx.ui.notify(
							`9router connection updated — ${models.length} models`,
							"info",
						);
					} catch (err) {
						if (isStaleDiscoveryError(err)) continue;
						markDiscoveryFailure(
							err,
							"connection update failed",
							discovery.generation,
						);
						ctx.ui.notify(
							`Failed to connect: ${discoveryStatusLine()}`,
							isAuthError(err) ? "warning" : "error",
						);
					}
				}

				if (choice === "Reasoning") {
					const reasoningChoice = await ctx.ui.select(
						`9router reasoning is currently ${config.enableReasoning ? "enabled" : "disabled"}. Enable only for routes/models that support reasoning.`,
						["Enable reasoning", "Disable reasoning"],
					);
					if (!reasoningChoice) continue;
					config = {
						...config,
						enableReasoning: reasoningChoice === "Enable reasoning",
					};
					persistConfig(pi, config);
					if (discoveredModels.length > 0) {
						registerNineRouterProvider(
							pi,
							config,
							discoveredModels,
							modelMetadataIndex,
						);
						setProviderRegistration(config);
					}
					ctx.ui.notify(
						`9router reasoning ${config.enableReasoning ? "enabled" : "disabled"}`,
						"info",
					);
				}

				if (choice === "View status") {
					const test = await testConnection(config, ctx.signal);
					const lines = [
						"🔗 9router Status",
						"",
						`Base URL:    ${config.baseUrl}`,
						`API Key:     ${config.apiKey ? maskApiKey(config.apiKey) : "not set"}`,
						`Reasoning:   ${config.enableReasoning ? "enabled" : "disabled"}`,
						`Connection:  ${test.ok ? "🟢 connected" : `🔴 ${test.error || "disconnected"}`}`,
						`Discovery:   ${discoveryStatusLine()}`,
						`Models:      ${discoveredModels.length} available`,
						`Metadata:    ${modelMetadataIndex.size > 0 ? `${modelMetadataIndex.size} index keys cached` : "unavailable"}`,
					];
					ctx.ui.notify(lines.join("\n"), test.ok ? "info" : "warning");
				}
			}
		},
	});

	// ---------------------------------------------------------------------------
	// Command: /9router-reasoning
	// ---------------------------------------------------------------------------
	pi.registerCommand("9router-reasoning", {
		description: "Enable or disable Pi thinking levels for 9router models",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui.select(
				`9router reasoning is currently ${config.enableReasoning ? "enabled" : "disabled"}. When enabled, Pi exposes thinking levels and sends reasoning_effort to 9router.`,
				["Enable reasoning", "Disable reasoning"],
			);
			if (!choice) return;

			config = {
				...config,
				enableReasoning: choice === "Enable reasoning",
			};
			persistConfig(pi, config);

			if (discoveredModels.length > 0) {
				registerNineRouterProvider(
					pi,
					config,
					discoveredModels,
					modelMetadataIndex,
				);
				setProviderRegistration(config);
			}

			ctx.ui.notify(
				config.enableReasoning
					? "9router reasoning enabled. Use Pi's thinking controls (Shift+Tab or --thinking) to choose the level."
					: "9router reasoning disabled. 9router models will use thinking level off.",
				"info",
			);
		},
	});

	// ---------------------------------------------------------------------------
	// Command: /9router-reload
	// ---------------------------------------------------------------------------
	pi.registerCommand("9router-reload", {
		description: "Reload models from 9router",
		handler: async (_args, ctx) => {
			const discovery = beginDiscovery();
			try {
				const models = await refreshModels(
					discovery.config,
					discovery.generation,
					ctx.signal,
				);
				ctx.ui.notify(
					`9router reloaded — ${models.length} models (${config.enableReasoning ? "reasoning enabled" : "reasoning disabled"})`,
					"info",
				);
			} catch (err) {
				if (isStaleDiscoveryError(err)) return;
				markDiscoveryFailure(err, "reload failed", discovery.generation);
				ctx.ui.notify(
					`Reload failed: ${discoveryStatusLine()}`,
					isAuthError(err) ? "warning" : "error",
				);
			}
		},
	});
}
