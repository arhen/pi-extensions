/**
 * pi-vision self-check. Run: `bun src/self-check.ts` (from extension dir or anywhere).
 * Imports only core.ts + photon — no pi packages, so plain bun resolves it.
 */
import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  MIME,
  MAX_IMAGE_BYTES,
  cacheGet,
  cacheKey,
  cacheSet,
  cacheSize,
  clearCache,
  configPath,
  describeBase64,
  describeRawFile,
  isConfigComplete,
  loadConfig,
  modelSupportsImages,
  parseArgs,
  resetConfigCache,
  retryAfterMs,
  saveConfig,
  setCachePath,
  setConfigPath,
} from "./core.ts";

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`pi-vision self-check FAIL: ${msg}`);
};

// isolate cache from the real ~/.pi cache for the whole run
setCachePath(join("/tmp", `pi-vision-cache-${process.pid}.json`));
clearCache();

// model capability detection
assert(modelSupportsImages({ input: ["text", "image"] }), "vision model must be detected");
assert(!modelSupportsImages({ input: ["text"] }), "text-only model must not be detected");
assert(!modelSupportsImages(undefined), "missing model must not be detected");

// env config (point configPath away so the real ~/.pi/pi-vision.json can't interfere)
resetConfigCache();
setConfigPath(join("/tmp", `pi-vision-env-${process.pid}.json`));
process.env.PI_VISION_BASE_URL = "https://example.com/v1";
const cfg = loadConfig();
assert(cfg.baseUrl === "https://example.com/v1", "env baseUrl must load");
assert(cfg.prompt.length > 20, "default prompt must exist");
assert(cfg.maxTokens > 0, "maxTokens must default");
delete process.env.PI_VISION_BASE_URL;
setConfigPath(null); // back to real config
resetConfigCache();

// mime map
assert(MIME[".png"] === "image/png", "png mime map");
assert(!MIME[".txt"], "txt must not be treated as image");

// command arg parsing
const s = parseArgs("set baseUrl=https://x/v1 apiKey=sk-12345678 model=qwen-vl-max");
assert(s.action === "set" && s.values.baseUrl === "https://x/v1" && s.values.model === "qwen-vl-max", "set parse");
const sp = parseArgs("set provider=kitchen model=gemma");
assert(sp.values.provider === "kitchen" && sp.values.model === "gemma", "registry-mode parse");
assert(isConfigComplete({ provider: "kitchen", model: "gemma", prompt: "p", maxTokens: 10 }), "registry mode complete");
assert(!isConfigComplete({ provider: "kitchen", model: "", prompt: "p", maxTokens: 10 }), "registry mode needs model");
assert(parseArgs("show").action === "show" && parseArgs("").action === "show", "show parse");
assert(parseArgs("reset").action === "reset", "reset parse");
assert(parseArgs('set prompt="a b c"').values.prompt === "a b c", "quoted prompt parse");
let threw = false;
try {
  parseArgs("set bogus=1");
} catch {
  threw = true;
}
assert(threw, "unknown key must throw");

// save/load roundtrip via temp file
setConfigPath(join("/tmp", `pi-vision-test-${process.pid}.json`));
try {
  const saved = saveConfig({ baseUrl: "https://tmp/v1", apiKey: "sk-test", model: "m" });
  assert(saved.model === "m" && loadConfig().baseUrl === "https://tmp/v1", "save/load roundtrip");
  saveConfig({ maxTokens: 42 });
  assert(loadConfig().maxTokens === 42 && loadConfig().model === "m", "merge keeps prior keys");
} finally {
  rmSync(configPath, { force: true });
  setConfigPath(null); // back to default ~/.pi/pi-vision.json
}

// describeBase64: mocked vision API roundtrip
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const imgUrl = body.messages[0].content.find((c: any) => c.type === "image_url").image_url.url;
    assert(imgUrl.startsWith("data:image/jpeg;base64,"), "image must be base64 data URL");
    assert(String(url).endsWith("/chat/completions"), "endpoint must be chat/completions");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "a chart with 3 bars" } }],
        usage: { prompt_tokens: 12, completion_tokens: 5 },
      }),
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;

  const out = await describeBase64("c2stZmFrZQ==", "image/jpeg", {
    baseUrl: "https://api.example.com/v1",
    apiKey: "k",
    model: "m",
    prompt: "p",
    maxTokens: 100,
  });
  assert(out.text === "a chart with 3 bars", "description text passes through");
  assert(out.usage?.input === 12 && out.usage?.output === 5, "usage maps from OpenAI fields");
  assert(out.usage?.totalTokens === 17, "totalTokens sums");
  assert(typeof out.usage?.cost?.total === "number" && out.usage.cacheRead === 0, "usage shape complete (footer-safe)");

  // transient error (5xx/429) → retry once, then throw
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    return {
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "1" }),
      text: async () => "Requests per minute limit exceeded",
    } as unknown as Response;
  }) as typeof fetch;
  let apiThrew = false;
  const t0 = Date.now();
  try {
    await describeBase64("eA==", "image/png", {
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      prompt: "p",
      maxTokens: 100,
    });
  } catch {
    apiThrew = true;
  }
  assert(apiThrew && attempts === 2, "transient error must retry once then throw");
  assert(Date.now() - t0 >= 900, "429 retry must honor Retry-After (>= ~1s wait)");

  // transient error + abort signal: clean rejection during the backoff — no second
  // attempt, no waiting out the full Retry-After (regression: rejectRetry was never
  // defined, so signal + transient error threw ReferenceError instead of retrying)
  let abortedAttempts = 0;
  const ac = new AbortController();
  globalThis.fetch = (async () => {
    abortedAttempts++;
    return {
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "5" }),
      text: async () => "Requests per minute limit exceeded",
    } as unknown as Response;
  }) as typeof fetch;
  let abortErr: Error | null = null;
  const abortT0 = Date.now();
  const abortP = describeBase64("eA==", "image/png", {
    baseUrl: "https://api.example.com/v1",
    apiKey: "k",
    model: "m",
    prompt: "p",
    maxTokens: 100,
  }, ac.signal).catch((e: unknown) => {
    abortErr = e instanceof Error ? e : new Error(String(e));
  });
  setTimeout(() => ac.abort(), 150);
  await abortP;
  assert(abortErr !== null && abortErr.message.includes("aborted during retry"), "abort during retry must reject with a clear message");
  assert(abortedAttempts === 1, "abort during retry must not trigger a second attempt");
  assert(Date.now() - abortT0 < 2000, "abort must cut the backoff short (not wait 5s)");

  // retryAfterMs parsing
  assert(retryAfterMs("57", "") === 30000, "Retry-After must be capped at 30s");
  assert(retryAfterMs(null, "reset after 5s") === 5000, "body reset-after parsed");
  assert(retryAfterMs(null, "no hints here") === 1500, "default backoff");

  // model chain: m1 502s, m2 succeeds
  let calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const model = JSON.parse(String(init?.body)).model;
    calls.push(model);
    if (model === "m1") {
      return { ok: false, status: 502, text: async () => "down" } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;
  const chained = await describeBase64("eA==", "image/png", {
    baseUrl: "https://api.example.com/v1",
    apiKey: "k",
    model: "m1,m2",
    prompt: "p",
    maxTokens: 100,
  });
  assert(chained.text === "ok" && calls.length === 3 && calls[0] === "m1" && calls[2] === "m2", "model chain must fall through to m2 after m1 retry")
} finally {
  globalThis.fetch = originalFetch;
}

// cache: hit/miss + model-scoped keys + LRU eviction
setCachePath(join("/tmp", `pi-vision-cache2-${process.pid}.json`));
clearCache();
const cfgA = { baseUrl: "https://x/v1", apiKey: "k", model: "gemma", prompt: "p", maxTokens: 10 };
const keyA = cacheKey("QUJD", cfgA);
const keyB = cacheKey("QUJD", { ...cfgA, model: "sonnet" });
const keyC = cacheKey("REVG", cfgA);
assert(keyA !== keyB && keyA !== keyC, "cache keys must differ by model and image");
assert(cacheGet(keyA) === undefined, "miss before set");
cacheSet(keyA, "desc1");
cacheSet(keyB, "desc2");
cacheSet(keyC, "desc3");
assert(cacheGet(keyA) === "desc1" && cacheSize() === 3, "hit after set");

// describeBase64 uses the cache: second identical call must not hit the API
// (distinct image data — no collision with the manually-seeded keys above)
let fetches = 0;
globalThis.fetch = (async () => {
  fetches++;
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: "cached-now" } }], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
    text: async () => "",
  } as unknown as Response;
}) as typeof fetch;
const first = await describeBase64("QUJERUZH", "image/png", cfgA);
const second = await describeBase64("QUJERUZH", "image/png", cfgA);
assert(first.text === "cached-now" && second.text === "cached-now", "both calls return description");
assert(fetches === 1, "second call must be a cache hit (1 fetch total)");
assert(second.usage === undefined, "cache hit carries no usage");

// cache result: description must survive a fresh load from disk
// (persist is debounced; the pending timer writes to the CURRENT cachePath)
setCachePath(join("/tmp", `pi-vision-cache2-${process.pid}.json`));
await new Promise((r) => setTimeout(r, 1300));
clearCache(); // reload from disk on next access
assert(cacheGet(keyC) === "desc3", "description must survive disk roundtrip");
assert(cacheGet(cacheKey("QUJERUZH", cfgA)) === "cached-now", "fetch-cached entry survives disk roundtrip too");

// describeRawFile: 20MB guard on raw fallback
const bigFile = join("/tmp", `pi-vision-big-${process.pid}.bin`);
writeFileSync(bigFile, Buffer.alloc(MAX_IMAGE_BYTES + 1));
let bigThrew = false;
try {
  await describeRawFile(bigFile, {
    baseUrl: "https://x/v1",
    apiKey: "k",
    model: "m",
    prompt: "p",
    maxTokens: 10,
  });
} catch {
  bigThrew = true;
}
rmSync(bigFile, { force: true });
assert(bigThrew, "raw fallback must reject >20MB images");

console.log("pi-vision self-check OK");
