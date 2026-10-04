# pi-core-subagent before/after benchmark harness

Reusable, reproducible benchmark for the subagent extension's startup context and one real
child-delegation path. It runs an extension entry path under test with the machine's normal
settings/resources, minus the installed `@arhen/pi-core-subagent`, which is replaced in memory by
the target path. Nothing outside `bench/` is modified, and no session/settings/cache state is
written by the harness itself.

- Entry point: `bench/subagent-bench.ts`
- Libraries: `bench/lib/{args,session,probe,samples,report,selftest}.ts`
- Raw runs + JSON reports: `bench/results/` (gitignored; `--out` picks the report path)
- Frozen baseline target: `/tmp/pi-subagents-modes.luyKyX/baseline/src/index.ts`
  (sha256 `1e0f387656bbd8e6196fc71de0e55dddb5aaa0b5cc63cd18e666fc8dafaf61d3`)

## Workflows

1. **startup** — fresh ephemeral parent session, prompt `hi`. Records build/setup ms, active
   tool count, exact tool declarations from the outgoing provider request
   (`before_provider_request`: names, per-tool description/schema bytes), reported provider
   input/cacheRead/cacheWrite/output/reasoning tokens, first streamed thinking/text ms, settle ms.
2. **delegate** — one real read-only child via the extension tool: parent must delegate a task
   whose child replies exactly `BENCH_OK`, no tools, no file writes, no worktree. Records
   route/discovery/dispatch latency, parent and child usage separately, child session file,
   model/thinking/tools, completion and final settle latency, tool calls, and the extension
   event-bus notification trail. The exact child task, prompt, empty tools, read-only flag,
   model/thinking and autoAwait are fixed by `lib/contract.ts`; changed arguments invalidate
   the sample. Schema discovery is allowed and measured if the parent needs it.

Sessions are in-memory (`SessionManager.inMemory`); child sessions are persisted by the extension
itself, and their JSONL is parsed for usage when no run snapshot is available.

## Offline verification (no API calls)

```bash
bun packages/core/pi-core-subagent/bench/subagent-bench.ts --help
bun packages/core/pi-core-subagent/bench/subagent-bench.ts --self-test
bun packages/core/pi-core-subagent/bench/subagent-bench.ts --dry-run \
    --target /tmp/pi-subagents-modes.luyKyX/baseline/src/index.ts
```

- `--self-test` exercises the probe, distributions, run-snapshot picking, child JSONL parsing,
  codemode plan states, package filtering, summary comparison and report round-trip
  (`SELF-TEST PASS (9 checks)`).
- `--dry-run` builds the real resource loader and session offline, prints the loaded extension
  list, duplicate-tool check, active tools, command availability and build timings. With
  `--mode direct|codemode|auto` it also invokes the mode command and requires the preflight
  disposition to be `handled`, so the command contract is validated without a model call.

## Recommended baseline commands (run from the repo root)

```bash
# Typechecks
bun run --cwd packages/core/pi-core-subagent typecheck
bunx tsc --noEmit -p packages/core/pi-core-subagent/bench/tsconfig.json

# Baseline profile: startup + one delegation, 3 valid samples each
bun packages/core/pi-core-subagent/bench/subagent-bench.ts \
  --target /tmp/pi-subagents-modes.luyKyX/baseline/src/index.ts \
  --mode baseline --codemode active \
  --workflow all --samples 3 \
  --out /tmp/pi-subagents-modes.luyKyX/bench-baseline-codemode-active.json

# Matched control: codemode inactive
bun packages/core/pi-core-subagent/bench/subagent-bench.ts \
  --target /tmp/pi-subagents-modes.luyKyX/baseline/src/index.ts \
  --mode baseline --codemode disabled \
  --workflow all --samples 3 \
  --out /tmp/pi-subagents-modes.luyKyX/bench-baseline-codemode-disabled.json

# Optional prompt variation: a same-length nonce is prepended to the USER prompt.
# This does not bust the cached system/tool prefix or guarantee a cold request.
bun packages/core/pi-core-subagent/bench/subagent-bench.ts \
  --target /tmp/pi-subagents-modes.luyKyX/baseline/src/index.ts \
  --mode baseline --workflow startup --samples 3 --cold-nonce \
  --out /tmp/pi-subagents-modes.luyKyX/bench-baseline-cold-startup.json
```

After the implementation gate, the same harness profiles the candidate source (the mode command
is invoked before prompting; `--codemode-command` is optional and off by default):

```bash
bun packages/core/pi-core-subagent/bench/subagent-bench.ts \
  --target packages/core/pi-core-subagent/src/index.ts \
  --mode auto --codemode active --workflow all --samples 3 \
  --compare-to /tmp/pi-subagents-modes.luyKyX/bench-baseline-codemode-active.json \
  --out /tmp/pi-subagents-modes.luyKyX/bench-after-auto-codemode-active.json
```

If the candidate has no `/subagents` command yet, live runs with `--mode direct|codemode|auto`
fail fast unless `--allow-missing-mode-command` is passed. `--mode baseline` never invokes the
command (the frozen baseline has no `mode` subcommand).

## How the target replaces the installed extension

1. Normal settings are loaded with `SettingsManager.create(cwd, agentDir)` and the effective
   value is copied into `SettingsManager.inMemory(...)`.
2. Only `npm:@arhen/pi-core-subagent` (string or object package source) is removed from
   `packages`; every other package, skill, prompt, theme, context file and extension stays.
3. The target path is injected via `DefaultResourceLoader.additionalExtensionPaths`, so the
   installed copy never loads and duplicate tool/command registrations cannot occur. The report
   records `integrity.duplicateTools` and `extensionsLoaded` as proof.
4. The SDK does not auto-load the CLI built-ins; the harness adds `createCodemodeExtension()`
   itself (mode from `--codemode`, activated through the normal `defaultTools` list).
5. `--agent-dir`, `--cwd`, `--provider`, `--model`, `--thinking` and `--model-refresh
   offline|network` pin the environment; defaults are `~/Code`,
   `opencode-go/deepseek-v4.1-flash`, thinking `max`, offline catalog refresh.

## Report contents

Each report contains `config`, `integrity`, `summary` (per-workflow distributions: setup,
stream timings, raw token fields, declaration count, parent/child usage, calls), all `samples`,
and `rawFiles` pointing at per-sample raw JSON. Token fields are raw provider values:
`input`, `cacheRead`, `cacheWrite`; computed `fullInput = input + cacheRead + cacheWrite` and
`inputPlusCacheRead = input + cacheRead`, with `cacheState` = `warm-observed` (cacheRead > 0),
`cold-observed` (cacheRead == 0 and cacheWrite > 0) or `cache-unknown` (neither reported).
A fresh session is never labelled cold unless the provider says so.

## Coverage limitations (also written into every report)

- 3 samples are indicative, not statistically conclusive; no p95/significance claims.
- Declared tools are captured from the real outgoing request; tools reachable only through
  codemode `ALL_TOOLS`/`searchTools` are not individually enumerated (codemode's declaration
  description/schema sizes are measured instead).
- Child usage is "when available": run snapshot when the parent fetched status/result, else the
  persisted child session JSONL; a child killed before persisting has none.
- Startup and delegation both apply the requested mode before the measured prompt. Startup
  rejects errors, retries, missing declarations, extra model calls, and unexpected tool calls;
  delegation requires exactly BENCH_OK, one completed child, zero child tools and no worktree.
- Mode application is verified by what happened (routing, declarations, run snapshots), not by
  command registry inspection alone. Registry/typecheck evidence is not execution evidence.
- The harness does not touch global settings/auth, does not install packages, and never claims
  speedups from token reduction alone.
- SDK/tool-loop semantics: when the parent uses `autoAwait: true` (which the default delegate
  prompt tends to produce because it says "wait until finished"), the `subagent` tool call blocks
  inside `execute()` until the child completes. Then `dispatchMs` (tool start -> tool end) spans
  the child run; read `firstChildOutputMs`/`completionMs` for spawn -> first output/completion,
  and `routing.usedAutoAwait` tells you how to read `dispatchMs`. The legacy
  `firstChildOutputMs` field uses the first finalized assistant JSONL-entry timestamp, NOT
  first-token streaming latency; do not use it as child TTFT. A background route (`autoAwait`
  absent) returns the tool immediately and delivers the completion as a follow-up turn; both
  routes are recorded without preference.
- Unrelated extensions can print shutdown warnings to stderr when the ephemeral session is
  disposed (observed: pi-9router "ctx is stale"). They do not affect measured timings or usage.

## Smoke evidence (one sample per workflow, baseline, this harness)

`--workflow all --samples 1` against the frozen baseline target succeeded:
startup setup ≈ 394 ms, 20 declarations, input 11 762 / cacheRead 0, first text ≈ 3 746 ms,
settle ≈ 3 791 ms; delegation route `subagent`, parent 2 calls, child 1 call with `BENCH_OK`,
0 tool calls, completion ≈ 6 245 ms, final settle ≈ 8 616 ms.

A separate `--workflow delegate --samples 1 --verbose` rerun (after capturing tool args) showed
the parent chose `autoAwait: true`: discovery ≈ 3 458 ms, tool-call block ≈ 1 558 ms,
first child output ≈ 5 011 ms, completion ≈ 5 519 ms, settle ≈ 7 316 ms; parent raw usage
input 59 + cacheRead 11 776 + output 204 (call 1), input 437 + cacheRead 11 776 + output 14
(call 2), child 1 call input 5 770 / cacheRead 0 / output 5 / 0 tool calls / `BENCH_OK`.
Single samples are indicative only; the baseline gate uses 3 samples per profile.
