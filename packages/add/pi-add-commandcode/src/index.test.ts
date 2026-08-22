// Run: npx tsx src/index.test.ts   (hits the live public /models endpoint)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getModels } from "@earendil-works/pi-ai/compat";
import factory from "./index.ts";

const builtin = new Set(getModels("anthropic").map((m) => m.id));
const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const priced = [...src.matchAll(/^ {2}"([^"]+)": \[/gmu)].map((m) => m[1]);
assert.equal(new Set(priced).size, priced.length, "duplicate id in CATALOG");

const res = await fetch("https://api.commandcode.ai/provider/v1/models");
assert.equal(res.status, 200);
const live = ((await res.json()) as { data: { id: string }[] }).data.map(
  (m) => m.id,
);

// Every live model must resolve to metadata from exactly one source: Claude ids from
// pi's Anthropic catalog, the rest from CATALOG. A model in neither bills as free.
const claude = live.filter((id) => id.startsWith("claude-"));
const rest = live.filter((id) => !id.startsWith("claude-"));
assert.ok(claude.length > 0 && rest.length > 0, "endpoint split untested");

const noMeta = claude.filter((id) => !builtin.has(id));
assert.deepEqual(noMeta, [], `claude ids absent from pi's catalog: ${noMeta}`);

const unpriced = rest.filter((id) => !priced.includes(id));
assert.deepEqual(unpriced, [], `CATALOG is missing live models: ${unpriced}`);

const overlap = priced.filter((id) => id.startsWith("claude-"));
assert.deepEqual(overlap, [], `claude ids duplicated in CATALOG: ${overlap}`);

const stale = priced.filter((id) => !live.includes(id));
if (stale.length) console.warn(`stale (delisted upstream): ${stale}`);

// Run the real factory against a stub API and inspect what it registers.
type Cfg = {
  models?: { id: string; api?: string; baseUrl?: string; cost: unknown }[];
  refreshModels?: (ctx: unknown) => Promise<{ id: string }[]>;
};
let cfg: Cfg | undefined;
await factory({
  registerProvider: (_n: string, c: Cfg) => {
    cfg = c;
  },
  registerCommand: () => {},
  on: () => {},
  // biome-ignore lint/suspicious/noExplicitAny: stub of the ExtensionAPI surface used here
} as any);

const models = cfg?.models ?? [];
assert.equal(
  models.length,
  live.length,
  "factory must register the live catalog before startup finishes, so the " +
    "models exist for interactive startup (docs/custom-provider.md)",
);

for (const id of claude) {
  const m = models.find((x) => x.id === id);
  assert.equal(m?.api, "anthropic-messages", `${id} must use Messages`);
  assert.ok(
    m?.baseUrl?.endsWith("/provider"),
    `${id} baseUrl must omit /v1 — the Anthropic SDK appends /v1/messages`,
  );
}
for (const id of rest.slice(0, 5)) {
  const m = models.find((x) => x.id === id);
  assert.equal(m?.api, "openai-completions", `${id} must use Completions`);
}

// Regression: refreshModels REPLACES the provider's models, so a refresh with an
// empty store must fall back to the factory catalog instead of wiping it.
const refreshed = await cfg?.refreshModels?.({
  stored: undefined,
  allowNetwork: false,
  publish: async () => true,
});
assert.equal(
  refreshed?.length,
  live.length,
  "offline refresh with an empty store must not empty the catalog",
);

console.log(
  `ok — ${models.length} registered by the factory (${claude.length} via /messages, ${rest.length} via /chat/completions); offline refresh preserved ${refreshed?.length}`,
);
