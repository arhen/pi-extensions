# Native exposure modes

`pi-core-subagent` presents its subagent toolset in two native Pi profiles and switches between
them with `/subagents mode`. This document describes the contract and measured startup/delegation
trade-offs; initial evidence is in [native-modes-benchmarks.md](native-modes-benchmarks.md).
The [targeted-discovery follow-up](targeted-discovery-benchmarks.md) records its frozen guide and
first-versus-consecutive delegation costs. Those measurements predate the legacy-default correction.

## Modes

| Mode | Subagent tool exposure | Declared to the model | Callable from scripts |
|---|---|---|---|
| `direct` (default) | native `direct`, ungrouped | yes, full schemas under normal Pi loadout policy | only the active tools |
| `codemode` | active tools `deferred` (namespace `subagents`), inactive tools `model-only` | no (the active declarations are hidden) | only the active tools |

- `direct` is the default, including existing branches with no stored preference. Activating the
  codemode tool alone does not change subagent routing. Native `direct` exposure preserves both
  model-issued calls and legacy active-tool script calls; tools are not namespace-grouped.
- `auto` is opt-in via `/subagents mode auto`. It selects the codemode profile only while the built-in
  `codemode` tool is actually in the active set (`pi.getActiveTools()`), and direct otherwise.
  Registration alone does not count.
- An explicit `codemode` preference falls back to the direct profile while codemode is inactive and
  reports the reason; it switches automatically once codemode becomes active.
- Native global `codemode.mode: "only"` remains authoritative, just as with legacy tools: it hides
  direct declarations globally while retaining script callability. Merely activating codemode in
  its normal `on` mode does not hide direct subagent declarations. This extension does not rewrite
  global codemode policy.
- The codemode profile keeps only own tools that are really active script-callable. A helper the
  user deactivated is re-registered as `model-only`, so it is neither declared nor reachable from a
  script; reactivating it natively makes it `deferred` again at the next boundary. This keeps a
  deactivated helper out of scripts even at the same request boundary.

## Migration and trying codemode

Published 1.3.63 used `auto` by default and `model-only` for its direct profile. The corrected source
restores native legacy `direct` behavior. This correction is effective only after that source is
released/loaded; it does not retroactively change the existing npm tarball.

To try the new routing: `/subagents mode auto` (or `/subagents mode codemode`). To return:
`/subagents mode direct`. Inspect the current preference/effective profile with `/subagents mode`.
Explicit saved choices are preserved, including `auto` chosen in 1.3.63. New sessions and branches
without an entry start direct. No global preference or consent is inferred from codemode activation.

## Tool surface

The extension has 9 registered tools; the same nine definitions are re-registered per profile, so every
operation below follows the active mode:

| Tool | Purpose |
|---|---|
| `subagent_models` | list the models a task may name: reference, honored thinking levels, context window and catalog price |
| `subagent` | run one agent or a `tasks`/`chain`/`needs` batch in the background |
| `subagent_status` | live per-task snapshot including child session file paths |
| `subagent_result` | final text, usage and worktree branch/diff summary |
| `await_subagent` | block until a run finishes or the timeout elapses |
| `reply_subagent` | answer a child `ask_parent` question and resume it |
| `steer_subagent` | inject a steering message into running tasks |
| `resume_subagent` | revive a failed/aborted task with its context and branch |
| `subagent_cancel` | abort a run and kill its children |

## Model discovery and precedence

`subagent_models` follows the active profile like every other operation and preserves the installed
1.3.62 catalog semantics:

- **Scope**: the session's `ctx.scopedModels` when scoping is configured, else
  `modelRegistry.getAvailable()`; the rendered output states which case applies.
- **Entries**: each row carries an exact round-trippable `provider/id` reference, the thinking levels
  pi's own resolver honors (a null-mapped `off`/`xhigh`/`max` is not advertised, so the runtime never
  silently clamps a listed level), the context window, and catalog per-Mtok rates. A model is `free`
  only when every reported rate is zero; absent rates read `unavailable` and unreported cache rates
  are named, never shown as free.
- **Ambiguity and faults**: a reference whose bare id would resolve to another model is reported as
  ambiguous instead of listed; a registry fault is reported separately; an empty catalog throws so
  the failure is not silently rendered as "no models".
- **Preferences**: `~/.pi/agent/subagent-models.json` (`prefer`/`hide`/`default`) shapes and orders
  the listing only. An unusable file is reported and ignored, matched-nothing patterns are reported
  as inert, and a `default` that is not listed is surfaced without being suggested as selectable.
  Hiding never removes permission: a hidden model still runs when named.
- **Precedence**: `chooseModel` is the single owner of the rule that a matched agent file's `model`
  frontmatter wins over the inline `model`; spawn validation, `runChild` and resume all resolve
  through it, and resume clamps the stored thinking level against the model the resumed task will
  actually run. `manager.resolveChildModel` stays exported for legacy callers.

## Commands

- `/subagents mode` — report preference, effective mode and codemode availability.
- `/subagents mode auto|direct|codemode` — set the preference for this session branch.
- Existing `/subagents`, `/subagents peek` and `/subagents auto-limit` behavior is unchanged.

## Persistence

The preference is stored per session branch with `pi.appendEntry("subagent-mode", { mode })` and
restored from `ctx.sessionManager.getBranch()` on `session_start`, so reload, resume, fork and tree
navigation keep it. Nothing is written to global or project settings, and the shared
`subagents-config.json` (auto-limit) is untouched.

## How the profiles map to native Pi APIs

- **Exposure**: `ToolDefinition.exposure` is re-applied by re-registering the same nine tool
  definitions. Re-registration preserves the active selection; the manager and live runs are never
  recreated. `sync()` re-registers when the effective mode changes or when the own-tool membership
  of the active set changes.
- **Native default activation**: the initial registration leaves `defaultActive` at its native
  default, so the tools are available by default. Every later re-registration sets
  `defaultActive: false`, which keeps the SDK's `_refreshToolRegistry` from auto-activating a tool the
  user deactivated when an exposure moves from `deferred` to native `direct`.
- **Allowlist restore**: with an explicit `--tools`/`defaultTools` allowlist the SDK activates every
  declarable tool whose name is listed, ignoring `defaultActive`. `register()` therefore restores
  exactly the own-name membership that was requested with `pi.setActiveTools()`, and only when the
  SDK actually changed it. Every unrelated name — including a newly registered one — is preserved
  verbatim; no other selection is ever pushed.
- **Namespace**: the codemode profile sets
  `namespace: { name: "subagents", description, instructions }`. The long reference lives in
  `instructions` and is read on demand with `describeNamespace("subagents")`; deferred tools are not
  listed in the codemode description, so no schema is inlined, including at the default
  `inlineBudget` of 3000. The reference spells every long operation with its real object arguments
  (`subagent_status({ runId })`, `resume_subagent({ runId, taskId, message?, model?, thinking? })`)
  and carries the agent-file rule: files are matched by `description`/goal, never by name; a match is
  authoritative for body and `model`, and only the per-call `tools` and `write` override its tools.
- **Targeted discovery**: the upfront guide names `await tools.subagent(args)`. When the signature
  is unknown, use `text(await describeTool("subagent"))` once and reuse it. Discover other helpers
  by exact name only when needed; broad searches and tool dumps are unnecessary.
  `describeNamespace("subagents")` remains the optional full reference. Calls use the normal nested
  pipeline, so argument validation, `tool_call`/`tool_result` hooks and error results are unchanged.
- **Declaration hiding**: every subagent tool carries a `prepareLoadout` hook that hides the active
  subagent declarations **while the codemode profile is really applied** (`applied`), never from a
  pending preference. Only those declarations are hidden; other tools keep their loadout. The tools
  stay active and callable, and their short `promptGuidelines` (discovery note plus the essential
  read-only/worktree, health-check, failure/resume, no-idle-wait and verification rules) remain in
  the system prompt.
- **Boundaries**: `session_start`, `session_tree`, `before_agent_start` and **`turn_start`** run
  `sync()`. `turn_start` is emitted before each model request of a multi-turn run, so a codemode
  availability change or a helper activation/deactivation made between turns reaches the next request
  with correct declarations and executability without another user prompt. The boundary is safe: no
  request or tool is executing, and manager runs are untouched. A `/subagents mode` command issued
  while the agent is not idle (`ctx.isIdle() === false`, for example mid-stream or while a script
  executes) stores the preference but defers re-registration to the next boundary, so a live call is
  never invalidated by an exposure change and the applied loadout is never rewritten mid-flight.

## Safety invariants

- No global or project settings, codemode settings, version numbers or installed packages are
  changed. `codemode` is never enabled behind the user's back.
- The active tool selection is preserved; unrelated tool names are never added or removed. The only
  `pi.setActiveTools()` call removes an SDK force-activation of **own** names under an explicit
  allowlist; unrelated names keep their membership and order.
- Explicit `--tools`/`defaultTools` allowlists and `noTools` continue to decide whether the subagent
  tools are registered/reachable at all.

## Verification

- `bun run typecheck && bunx tsc --noEmit -p bench/tsconfig.json && bun run lint && bun test &&
  bun bench/subagent-bench.ts --self-test` in `packages/core/pi-core-subagent`.
- `test/presentation/mode-contract.test.ts` pins the exposure, hiding, command, persistence,
  selection-preservation, pending-preference and boundary-deferral contract with a harness that
  mirrors `_applyToolLoadout`. All nine operations are asserted, not just the eight legacy ones; the
  codemode profile is asserted per active membership (active = `deferred`, inactive = `model-only`).
- `test/presentation/selection-regression.test.ts` runs real Pi 1.0.1 sessions with the native
  codemode extension and a faux provider: manually deactivated helpers stay deactivated across a
  mode switch and stay non-callable after the next request boundary; a partial `--tools` allowlist
  cannot resurrect a deactivated helper while an unrelated allowlisted tool survives; `noTools`
  leaves the tools unreachable; toggling codemode availability or a helper's active membership
  between model turns reaches the next request of the same run with correct declarations and
  executability; and a mode change during a blocked, live codemode script keeps that call usable,
  leaves the applied exposures untouched, and applies at the next request.
- `test/presentation/runtime.test.ts` runs real Pi 1.0.1 sessions with the native codemode extension
  (modes `on` and `only`, `inlineBudget: 3000` and `1_000_000`) and a faux provider: declaration
  capture, discovery through the QuickJS sandbox, nested validation, allowlist and `excludeTools`
  behavior, model-issued schema validation, `navigateTree` preference restore, session reopen, and
  the profile boundary (legacy direct tools retain active-tool script compatibility).
- `test/presentation/runtime-child.test.ts` drives real child sessions through the manager with the
  faux provider and an isolated HOME: background spawn + await + result, `autoAwait`, ask/reply
  intercom, steer delivery to a parked child, cancellation, failed-task resume, and a nested
  `tools.subagent`/`tools.await_subagent` codemode route. A live child is asserted to survive a mode
  switch and still complete. `fork()`/`new session` are not exercised natively (no public session
  API in this harness); branch-scoped preference across replacement is covered by `navigateTree` and
  session reopen plus the mode-contract branch tests.
- `test/presentation/targeted-discovery.test.ts` checks the explicit spawn pointer, targeted native
  schema lookup and unavailable inactive spawn. Guidance was changed only after its new test failed.
- The initial mode delivery passed 319 tests / 1310 assertions. Targeted discovery and repeated-use
  benchmark verification are recorded separately in the follow-up report.
- `test/presentation/legacy-default.test.ts` adds tests-first regression coverage for the default
  with active codemode, restored explicit choices, branch reset, availability toggles, all nine
  native declarations, real script dispatch, explicit auto opt-in and direct reversion. Existing
  codemode tests now select that profile explicitly. README migration guidance was added without
  overwriting the pre-existing local edits.

## Initial measured results

The table below predates targeted discovery guidance and the legacy-default correction. The frozen
follow-up measured 9,295 startup input in the opt-in codemode profile; see
[that report](targeted-discovery-benchmarks.md). Its direct profile was the former `model-only`
implementation, not the corrected native `direct` profile. No new measurements are claimed here.

Three samples per workflow/profile, Pi 1.0.1, DeepSeek V4.1 Flash MAX, default inline budget 3000.
Matched before is the frozen installed nine-tool package, not the older eight-tool development tree.
Full input includes cache reads/writes; fresh sessions can use cached prefixes.

| Profile | Global codemode | Startup input before → after | Saving | Subagent declarations |
|---|---|---:|---:|---:|
| direct | on | 12,081 → 11,497 | 584 / 4.8% | 9 |
| codemode | on | 12,081 → 9,250 | 2,831 / 23.4% | 0 |
| auto | on | 12,081 → 9,250 | 2,831 / 23.4% | 0 |
| auto fallback | disabled | 11,328 → 10,912 | 416 / 3.7% | 9 |

**Startup context shrinks; this is not an overall performance win.** In the controlled delegation
workflow, parent+child cumulative input medians increased from 27,847 to 46,667 (direct), 59,024
(codemode) and 52,820 (auto/on); the disabled comparison increased from 26,362 to 44,626. Child
input remained exactly 2,981. Namespace/schema discovery and additional model-catalog planning
requests are included, not hidden. Child completion medians were slower in every after profile.

Global `only` and large-budget omission are runtime-tested, not separately live-timed here.
See [native-modes-benchmarks.md](native-modes-benchmarks.md) for latency median/ranges, observed
cache counts, raw report paths, methodology and precise coverage limits. No startup speedup,
monetary savings or full native fork/new-session parity is claimed.
