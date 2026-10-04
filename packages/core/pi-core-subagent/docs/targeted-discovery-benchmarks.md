# Targeted discovery and repeated delegation

## Decision

Keep the targeted guide: it improves the previously measured codemode discovery path for **45 extra
startup tokens**. It does not establish codemode as faster or cheaper than original direct tools.
Choose codemode for a smaller startup context; choose direct exposure when first-use latency matters.
No default policy, installed package, version, settings, schema or lifecycle behavior was changed.

The guide names `await tools.subagent(args)` and recommends
`text(await describeTool('subagent'))` once when the signature is unknown, then reuse. Other helpers
are discovered by exact name as needed; namespace discovery is an optional full reference. This is
model guidance, not a mandatory lookup or hard discovery-round-trip cap.

## Controls and evidence

- Pi 1.0.1, Bun 1.4.0, `opencode-go/deepseek-v4.1-flash`, MAX, cwd `~/Code`; normal resources retained.
  Skill-tool remains uninstalled. Global codemode is `on`, inline budget 3000.
- Before/after differ **only in `src/presentation.ts`**. Fourteen production files were frozen and
  compared; all current production files equal the measured after snapshot.
- Frozen installed 1.3.62 with all nine operations is a separate original-direct reference.
- All parent prompts contain the same complete child arguments from `bench/lib/contract.ts`:
  one independent read-only task, exact `BENCH_OK`, MAX, explicit model, `tools: []`, no worktree,
  `autoAwait: true`, `notifyPerTask: true`. No discovery route is prescribed in the benchmark prompt.
  Supplying the arguments can let a model skip schema discovery; this is not a general coding workload.
- Fresh test: three startup plus three single-delegation sessions per profile, **18/18 valid**.
  Before/after ran concurrently; the installed reference followed.
- Repeated test: **three parent sessions × five consecutive delegations per profile**, all three
  profiles run concurrently. Numbered prompts require a new run; parent conversations are not
  rebuilt between calls. A completion notification, final settlement, idle state and 500ms bus-quiet
  interval precede the next prompt. Setup/quiet intervals are not included in per-call settlement time.
- Full input = uncached input + cache read + cache write, summed across every model request, including
  discovery and finalization. Each repeated child input was 2,980–2,981 tokens; output/reasoning and
  cache hits varied. Cache write was zero throughout.
- Independent verification read all **45 distinct child JSONL sessions**: distinct runs, exact output,
  one child model call, zero tools, matched model/MAX; token and cost totals match run snapshots.
  All parent per-call allocations equal whole-session usage, with zero unattributed tokens/requests.
- Evidence: `/tmp/pi-subagents-discovery.EqsijU/`, containing frozen `before/` and `after/`,
  `fresh-{before,after,installed}.json`, `repeat-{before,after,installed}.json`, matching `.raw/`,
  `verify.ts` and `verification.json`. These temporary artifacts are local, not committed.

## Fresh-session first use

Medians, three samples per profile. Completion timing in the existing fresh harness starts at sample
creation and includes setup; **do not compare it directly with the per-prompt repeated timings below**.
Dollar estimates include parent and child output as well as input.

| Profile | Startup full input | First delegation full input | Child completion | SDK cost estimate |
|---|---:|---:|---:|---:|
| Original direct | 12,081 | 27,868 | 5.708s | $0.000364 |
| Old codemode guide | 9,250 | 59,050 | 11.997s | $0.001529 |
| Targeted codemode guide | 9,295 | 34,233 | 7.601s | $0.000701 |

Versus the old guide: **42.0% less cumulative input, 36.6% shorter completion, 54.2% lower observed
catalog cost**. Startup grows 45 tokens (0.49%); saving versus original direct remains **23.1%**.
Original direct remains faster and lower-cost in this fresh workflow.

Old routes searched tools, read namespaces and/or dumped `ALL_TOOLS`: 4/5/6 parent model requests.
Targeted routes performed one exact lookup in two samples and no lookup in the third: 3/3/2 requests.
This reduces model round trips, not significant JavaScript execution time.

## Consecutive calls in the same session

Means of session-level aggregates. Calls 2–5 are averaged within each session before combining three
sessions; they are not twelve independent session samples. Old-guide first-use statistics have only
**two valid samples**, because its first session had a failed discovery script. Later calls in that
session remained valid. Failures are preserved, not retried or relabeled successful.

| Profile | Valid calls | First parent settlement | Calls 2–5 settlement | First full input | Calls 2–5 full input |
|---|---:|---:|---:|---:|---:|
| Original direct | 15/15 | 8.348s | 6.600s | 34,710 | 33,425 |
| Old guide | 14/15 | 17.574s (n=2) | 7.890s | 58,234 (n=2) | 34,850 |
| Targeted guide | 15/15 | 12.144s | 7.279s | 37,115 | 27,388 |

For targeted mode, later settlement was **40.1% shorter** than first use. All twelve later calls
skipped discovery and used two parent requests: dispatch plus finalization. The old guide also skipped
rediscovery later; its larger discovered transcript remained in subsequent inputs. History continues
to grow: targeted full input averaged 25,699 at call 2 and 29,047 at call 5.

Targeted first-use routes were still variable: one session used broad search/tool dumps, one used
one exact lookup, and one spawned immediately. A precise pointer improves the common path but does
not guarantee obedience or one lookup. Parent request counts were 5/3/2 on first use, then 2 throughout.

| Profile | First child completion | Calls 2–5 child completion | First SDK cost | Calls 2–5 SDK cost |
|---|---:|---:|---:|---:|
| Original direct | 6.223s | 4.260s | $0.000648 | $0.000326 |
| Old guide | 15.024s (n=2) | 5.163s | $0.001475 (n=2) | $0.000398 |
| Targeted guide | 9.526s | 4.943s | $0.000919 | $0.000374 |

Child completion is a finalized notification, **not streaming TTFT**.

### Five-call totals, including failures

These are mean observed effort across all three attempted sessions. The old guide includes the
invalid first discovery attempt and recovery; it is **not** a three-successful-session comparison.
Unlike valid-only epoch summaries, no failed work is discarded from these resource totals.

| Profile | Valid sessions | Five-call full input | Sum of settlement times | SDK cost estimate |
|---|---:|---:|---:|---:|
| Original direct | 3/3 | 168,410 | 34.748s | $0.001953 |
| Old guide | 2/3 | 199,215 | 48.942s | $0.003230 |
| Targeted guide | 3/3 | 146,669 | 41.262s | $0.002414 |

The two fully valid old-guide sessions alone averaged 192,029 input, 51.362s and $0.003148.
Across all attempted sessions, targeted mode used **26.4% less input**, **15.7% less settlement time**
and **25.3% lower estimated cost** than the old guide. Versus original direct, it used **12.9% less
input** but **18.7% more settlement time** and **23.6% higher estimated cost** in these samples.

## Cost and coverage limits

- Dollars are **Pi SDK catalog estimates, not OpenCode invoices or subscription charges**. The
  runtime catalog reported USD/Mtoken: input 0.15, output 0.60, cache read 0.003, cache write 0.
  Observed cache usage determines these estimates; fewer full-input tokens need not mean less money.
- Two targeted repeated children had zero cache-read tokens while original/old-guide children were
  cache hits. This and differing reasoning output affect the monetary comparison. The first targeted
  and original fresh startup also reported no cache read. A fresh parent session is not proof of a
  cold provider cache. No monetary ROI or general startup speedup is established.
- The old-guide failure shadowed the sandbox's `tools` binding while dumping `ALL_TOOLS`; its child
  eventually completed, but the sample remains invalid. One failure is not a reliability-rate estimate.
- Small concurrent batches, provider variance, asymmetric caches and fixed trivial children limit
  causal conclusions. No paid write lifecycle, workload-wide benchmark, or native fork/new-session
  coverage was added. Broader operation/state coverage remains the earlier mode delivery's evidence.
- The repeated harness has synthetic boundary tests, not native faux-session loop coverage. Its
  session-file fallback is outside this live evidence: all 45 children used validated run snapshots.
  Positive unattributed usage is surfaced by integrity diagnostics; this campaign independently
  requires zero. These limits do not imply broader harness guarantees.

## Verification and reproduction

Guidance regression failed before product changes; then three native targeted-discovery tests passed.
Initial repeated harness review found wrong completion origins and missing failure guards. Three
regressions ran red before corrections in `f4d65c34`; independent review then passed. Final gates:
**341 tests / 1452 assertions / 0 failures**, package and bench typechecks, full lint, fresh self-test
9/9 and repeated self-test 7/7. Twenty unrelated pre-existing diffs remain byte-identical.

```sh
cd packages/core/pi-core-subagent
bun run typecheck
bunx tsc --noEmit -p bench/tsconfig.json
bun run lint
bun test
bun bench/subagent-bench.ts --self-test
bun bench/subagent-repeat-bench.ts --self-test
bun bench/subagent-repeat-bench.ts --target TARGET --mode codemode --codemode active \
  --samples 3 --turns 5 --verbose --out report.json
```

Use the frozen before/after entries for targeted comparisons; use `--mode baseline` with the frozen
installed entry. `--dry-run` builds sessions and verifies commands offline without provider calls.
Before/after `index.ts` hashes are identical because only `presentation.ts` changed; full source
hashes are recorded in `verification.json`. Source guidance is commit `6069b351`; benchmark branch
`780d698a` is merged locally. Nothing was installed, published or version-bumped.
