// Run: npx tsx src/index.test.ts   (hits the live public /models endpoint)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";

const builtin = ANTHROPIC_MODELS as Record<string, unknown>;
const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const priced = [...src.matchAll(/^ {2}"([^"]+)": \[/gmu)].map((m) => m[1]);
assert.equal(new Set(priced).size, priced.length, "duplicate id in CATALOG");

const res = await fetch("https://api.commandcode.ai/provider/v1/models");
assert.equal(res.status, 200);
const live = ((await res.json()) as { data: { id: string }[] }).data.map(
  (m) => m.id,
);

// Every live model resolves to metadata from exactly one source: Claude ids from
// pi's Anthropic catalog, the rest from CATALOG. A model in neither bills as free.
const claude = live.filter((id) => id.startsWith("claude-"));
const rest = live.filter((id) => !id.startsWith("claude-"));
assert.ok(claude.length > 0 && rest.length > 0, "endpoint split untested");

const noMeta = claude.filter((id) => !builtin[id]);
assert.deepEqual(noMeta, [], `claude ids absent from pi's catalog: ${noMeta}`);

const unpriced = rest.filter((id) => !priced.includes(id));
assert.deepEqual(unpriced, [], `CATALOG is missing live models: ${unpriced}`);

const overlap = priced.filter((id) => id.startsWith("claude-"));
assert.deepEqual(overlap, [], `claude ids duplicated in CATALOG: ${overlap}`);

const stale = priced.filter((id) => !live.includes(id));
if (stale.length) console.warn(`stale (delisted upstream): ${stale}`);

console.log(
  `ok — ${claude.length} claude via /messages (pi metadata), ${rest.length} via /chat/completions (CATALOG)`,
);
