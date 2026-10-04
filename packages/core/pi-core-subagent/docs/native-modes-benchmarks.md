# Native mode measurements

These measurements precede the targeted discovery guide. See
[targeted-discovery-benchmarks.md](targeted-discovery-benchmarks.md) for the follow-up, including
same-session delegations, estimated costs and retained failures.

## Result

The scoped codemode profile reduces this measured fresh-session startup input by **2,831 tokens
(23.4%)**. Direct reduces it by **584 tokens (4.8%)** with codemode active. Auto selects those
profiles; with codemode disabled its direct fallback saves **416 tokens (3.7%)**.

These are **startup-context savings, not end-to-end savings**. The cold-discovery delegation
workflow used more cumulative input and took longer after the change. Do not claim an overall
speed, cost or delegation-token improvement from these samples.

## Method and provenance

- Native Pi 1.0.1, Bun 1.4.0; parent and child `opencode-go/deepseek-v4.1-flash`, thinking `max`.
- `cwd: ~/Code`; normal resources and other extensions retained. Skill-tool remains uninstalled.
- Three samples per workflow/profile: **A**, fresh in-memory session plus `hi`; **B**, fresh session
  delegates one read-only worker and returns its exact `BENCH_OK` in the same turn.
- B fixes the complete child argument object, model, thinking, task, prompt, `tools: []`,
  `write: false`, `autoAwait: true`, and `notifyPerTask: true`. Changed/truncated arguments,
  wrong output, extra children, child tools/worktree, mismatched model/thinking, errors or missing
  settlement invalidate a sample. Every recorded comparison sample is valid.
- Primary before: immutable installed 1.3.62 snapshot, all **nine** operations. Its `src/index.ts`
  SHA-256 is `6d81e35a58a820dee3aa958dd34e470260c44adbd99d4571f9026921443cdc40`.
- After: source commit `d6198347`, merged as `19ae8447`. Its `src/index.ts` SHA-256 is
  `2c78e1006d17fe7cbe3f518a1f07ce513dfbebeb6771eaf6c31b76dfb2bcdeaf`.
  Measurements use a detached immutable worktree; merged production files were compared with it.
- Harness controls are from `0ca6871c`, unchanged between the matched before/after runs. Both
  workflows apply the requested mode before measuring; command preflight is handled with zero
  model calls. Reports preserve raw usage, tool/routing records, declarations, settings and hashes.
- The older eight-tool development snapshot is a secondary reference, **not** the user-visible
  primary before. Its matching A/B reports are retained separately. Installed model/catalog and
  agent-file model-precedence behavior were reconciled before acceptance, rather than lost.
- Live timing uses global codemode `on` with default `inlineBudget: 3000`, or codemode disabled.
  Global `only`, large inline budgets, missing/inactive codemode, explicit selections and exclusions
  are tested with real native sessions/faux providers; their live timing was not measured here.

## A — startup input

Provider full input is `input + cacheRead + cacheWrite`. It is not just uncached input. Each
profile's full input and declaration count are identical across its three samples.

| Profile | Codemode | Full input | Saving vs matched before | Total declarations | Subagent declarations |
|---|---|---:|---:|---:|---:|
| Before, installed | on | 12,081 | — | 21 | 9 |
| Direct | on | 11,497 | 584 / 4.8% | 21 | 9 |
| Codemode | on | 9,250 | 2,831 / 23.4% | 12 | 0 |
| Auto | on | 9,250 | 2,831 / 23.4% | 12 | 0 |
| Before, installed | disabled | 11,328 | — | 20 | 9 |
| Auto fallback | disabled | 10,912 | 416 / 3.7% | 20 | 9 |

All nine active subagent schemas are absent from provider declarations and the codemode inline
catalog in the codemode profile. Native exposure and `prepareLoadout` accomplish this; the same
schemas are **not** copied into codemode's startup description. A discovery pointer and essential
health-check, read-only/isolation, merge, failure/recovery, no-idle-wait and independent-check rules
remain upfront. Long instructions and schemas are loaded only on demand.

### Observed cache and timing

All values are median **[minimum–maximum]**, seconds for time. Setup and startup latency start at
sample creation; first text and settlement include setup. Cache write was zero in every sample.
A fresh session is not proof of a cold provider cache.

| Profile | Uncached input | Cache read | Setup s | First text s | Settled s |
|---|---:|---:|---:|---:|---:|
| Before/on | 49 [49–12,081] | 12,032 [0–12,032] | 0.300 [0.281–0.467] | 2.524 [2.432–3.296] | 2.790 [2.433–3.469] |
| Direct/on | 105 [105–11,497] | 11,392 [0–11,392] | 0.456 [0.425–2.087] | 2.695 [2.535–5.144] | 2.697 [2.605–5.251] |
| Codemode/on | 34 [34–9,250] | 9,216 [0–9,216] | 0.293 [0.275–2.086] | 2.810 [2.721–4.342] | 2.837 [2.753–4.389] |
| Auto/on | 34 [34–34] | 9,216 [9,216–9,216] | 0.336 [0.291–0.964] | 3.633 [2.564–5.796] | 3.687 [2.618–5.830] |
| Before/disabled | 64 [64–11,328] | 11,264 [0–11,264] | 0.293 [0.276–0.419] | 2.707 [2.271–2.919] | 2.777 [2.358–2.983] |
| Auto/disabled | 32 [32–10,912] | 10,880 [0–10,880] | 0.577 [0.310–0.965] | 3.294 [2.844–4.055] | 3.427 [2.848–4.114] |

The direct settled median is 3.3% lower, but its first-text median is higher. The other after
medians are not faster. These small, non-interleaved samples do not establish a startup speedup;
module/cache warmup and provider latency vary. Auto/on and explicit codemode have the same startup
context despite their different observed latency.

## B — actual delegation, including discovery

All values are median **[minimum–maximum]**, seconds for time. Cumulative input sums every model
request, including discovery and finalization; parent and child are separate. Child full input
is **2,981 in every before/after sample**, with one child model call, no child tools, and exact
`BENCH_OK`. Child cache read is 2,944 in every sample; child uncached input is 37.

| Profile | Parent full input | Parent calls | Total parent + child input | Discovery/planning s | Child completion s | Parent settled s |
|---|---:|---:|---:|---:|---:|---:|
| Before/on | 24,866 [24,826–28,980] | 2 [2–2] | 27,847 [27,807–31,961] | 2.641 [2.585–4.650] | 4.432 [4.310–6.538] | 6.543 [6.417–8.801] |
| Direct/on | 43,686 [27,907–43,802] | 3 [2–3] | 46,667 [30,888–46,783] | 6.992 [5.360–7.074] | 9.344 [7.160–9.417] | 11.668 [9.309–11.797] |
| Codemode/on | 56,043 [49,113–59,302] | 5 [4–5] | 59,024 [52,094–62,283] | 9.399 [8.796–10.437] | 11.930 [11.076–13.232] | 13.488 [12.755–18.703] |
| Auto/on | 49,839 [41,765–49,982] | 4 [4–5] | 52,820 [44,746–52,963] | 8.761 [8.302–10.411] | 10.677 [10.666–12.714] | 14.716 [13.304–14.799] |
| Before/disabled | 23,381 [23,260–23,565] | 2 [2–2] | 26,362 [26,241–26,546] | 3.231 [2.231–3.740] | 5.187 [4.681–6.395] | 7.130 [6.296–8.130] |
| Auto/disabled | 41,645 [22,523–41,861] | 3 [2–3] | 44,626 [25,504–44,842] | 6.890 [3.439–8.149] | 9.236 [5.960–10.667] | 12.199 [8.288–13.436] |

The codemode samples make several discovery/model requests before spawning. Direct/auto-disabled
samples also frequently query `subagent_models`; sometimes the model queries it and spawns in the
same request, sometimes in separate requests. These real planning choices are included, not
removed to make the result look better. Three samples cannot attribute their frequency to a
particular instruction change or establish a general workload result.

Discovery/planning starts at the delegation prompt and ends at spawn, not just tool execution or
SDK lookup time. Completion and settlement timestamps start at sample creation and include setup.
`autoAwait: true` makes the spawn-tool dispatch span include child completion. The legacy
`firstChildOutputMs` derives from the first finalized JSONL assistant record; it is **not**
streaming child TTFT and is not reported as such.

### Parent cache accounting

| Profile | Parent uncached input median [range] | Parent cache read median [range] |
|---|---:|---:|
| Before/on | 634 [546–4,660] | 24,320 [24,192–24,320] |
| Direct/on | 4,902 [4,739–5,018] | 38,784 [23,168–38,784] |
| Codemode/on | 6,233 [3,307–15,526] | 43,776 [42,880–52,736] |
| Auto/on | 1,957 [1,583–6,206] | 43,776 [39,808–48,256] |
| Before/disabled | 597 [476–909] | 22,784 [22,656–22,784] |
| Auto/disabled | 4,653 [635–4,741] | 36,992 [21,888–37,120] |

Medians in different columns may come from different samples; do not add them to reconstruct a
median total. Raw per-call usage is authoritative. Token sums are not monetary billing claims.

## Capability and state evidence

- Tests preceded implementation: original baseline 160 passing tests; operation/state parity
  increased this to 211; mode-contract tests ran red before product edits. Installed catalog/model
  preservation tests also ran red before porting. Leader reproduced two additional selection
  regressions with failing real-native tests; the corrections were checked independently.
- Final: **319 tests / 1,310 assertions / zero failures**, package and benchmark typechecks,
  package lint and nine benchmark self-tests all pass. An independent final audit additionally
  repeated partial/full/no-allowlist mode cycles and same-run activation probes.
- All nine operations, legacy single/tasks/chain fields, graph ordering/concurrency, schema/error
  validation, model discovery/preferences/price/thinking/ambiguity and agent-file precedence remain.
- Real native/faux child sessions cover background/autoAwait, result/usage/session files,
  ask/reply, steer, cancellation and failed-task resume; a running child survives a mode switch.
- Real QuickJS executes nested calls/discovery/validation. Global `on`/`only`, default/large
  inline budgets, inactive/absent codemode, exclusions/no-tools, partial selections, same-run
  activation and a mode command during a blocked live VM are covered. Disabled helpers remain
  non-callable; own-selection repair does not force unrelated tools.
- Reopen and real tree navigation restore branch preference. Native fork/new-session commands
  are **not** exercised end-to-end: Pi 1.0.1's public `AgentSession` harness has no such methods.
  Session-start reason/branch reconstruction is covered by contract tests, not claimed as full
  native command parity. Real worktree creation/commit/reaping is tested separately, not through
  a paid write-agent lifecycle in these read-only benchmarks.
- Pre-existing SDK behavior: with a static explicit allowlist, a third-party tool registration
  can re-activate a manually disabled allowlisted helper. The independent audit reproduced this
  on the old baseline too. This change repairs its own registration path only, not that SDK policy.
- User README and unrelated dirty files remain untouched. The user's schema documentation wording
  `read, grep, find, ls, codemode` is preserved. No installed-package changes, settings writes,
  version bumps or publication occurred; the four Pi peer floors are `^1.0.1` as authorized.

## Reproduce and inspect

Evidence directory on the measurement machine: `/tmp/pi-subagents-modes.luyKyX`.

- `bench-installed-baseline-codemode-{active,disabled}.json` and matching `.raw/` directories.
- `bench-after-{direct,codemode}-active.json`, `bench-after-auto-{active,disabled}.json` and `.raw/`.
- `baseline-summary.md`, `baseline-hashes.json`, `acceptance.md`, `user-preexisting.patch`.
- Earlier uncontrolled attempts are named `exploratory-{active,disabled}` and excluded.

From the monorepo root, replace `TARGET` with the immutable before/after `src/index.ts` path:

```bash
bun packages/core/pi-core-subagent/bench/subagent-bench.ts \
  --target TARGET --mode codemode --codemode active --workflow all --samples 3 --out report.json
```

Use `--mode baseline` for before; repeat with direct, auto/active and auto/disabled as above.
The full configuration and exact prompts are preserved in every JSON report.
