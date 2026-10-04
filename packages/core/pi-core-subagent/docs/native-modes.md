# Native exposure modes

`pi-core-subagent` presents its subagent toolset in two native Pi profiles and switches between
them with `/subagents mode`. This document describes the contract; the measured results section is
a placeholder for the benchmark owner.

## Modes

| Mode | Subagent tool exposure | Declared to the model | Callable from scripts |
|---|---|---|---|
| `direct` | `model-only` | yes, full schemas | no |
| `codemode` | `deferred` (namespace `subagents`) | no (declarations hidden) | yes |

- `auto` (default) selects the codemode profile only while the built-in `codemode` tool is actually
  in the active set (`pi.getActiveTools()`), and the direct profile otherwise. Registration alone
  does not count.
- An explicit `codemode` preference falls back to the direct profile while codemode is inactive and
  reports the reason; it switches automatically once codemode becomes active.
- The direct profile uses `model-only` exposure, so the tools stay visible even under the global
  `codemode.mode: "only"` setting. They are not callable from codemode scripts in that profile.

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
  recreated. `sync()` re-registers only when the effective mode changes.
- **Namespace**: the codemode profile sets
  `namespace: { name: "subagents", description, instructions }`. The long reference lives in
  `instructions` and is read on demand with `describeNamespace("subagents")`; deferred tools are not
  listed in the codemode description, so no schema is inlined, including at the default
  `inlineBudget` of 3000.
- **Deferred discovery**: scripts find the tools with `searchTools("subagent")` or
  `ALL_TOOLS`, and call them as `tools.subagent(...)`, `tools.subagent_status(...)`, etc. Calls go
  through the normal nested-call pipeline, so argument validation, `tool_call`/`tool_result` hooks
  and error results are unchanged.
- **Declaration hiding**: every subagent tool carries a `prepareLoadout` hook that returns the active
  subagent names as `hiddenDeclarations` in the codemode profile. Only those declarations are
  hidden; other tools keep their loadout. The tools stay active and callable, and their short
  `promptGuidelines` (discovery note plus the essential read-only/worktree, health-check,
  failure/resume, no-idle-wait and verification rules) remain in the system prompt.
- **Boundaries**: `session_start` and `before_agent_start` run `sync()`; mode changes therefore take
  effect at the next request boundary and never cancel or restart a run. A `/subagents mode` command
  issued while the agent is not idle (`ctx.isIdle() === false`, for example mid-stream or while a
  script executes) stores the preference but defers re-registration to the next boundary, so a live
  call is never invalidated by an exposure change.

## Safety invariants

- No global or project settings, codemode settings, version numbers or installed packages are
  changed. `codemode` is never enabled behind the user's back.
- The active tool selection is preserved; unrelated tool names are never added or removed, and
  `setActiveTools` is not used to force subagent tools on.
- Explicit `--tools`/`defaultTools` allowlists and `noTools` continue to decide whether the subagent
  tools are registered/reachable at all.

## Verification

- `bun run typecheck && bun run lint && bun test` in `packages/core/pi-core-subagent`.
- `test/presentation/mode-contract.test.ts` pins the exposure, hiding, command, persistence,
  selection-preservation and boundary-deferral contract with a harness that mirrors
  `_applyToolLoadout`. All nine operations are asserted, not just the eight legacy ones.
- `test/presentation/runtime.test.ts` runs real Pi 1.0.1 sessions with the native codemode extension
  (modes `on` and `only`, `inlineBudget: 3000` and `1_000_000`) and a faux provider: declaration
  capture, discovery through the QuickJS sandbox, nested validation, allowlist and `excludeTools`
  behavior, model-issued schema validation, `navigateTree` preference restore, session reopen, and
  the profile boundary (direct model-only tools are not callable from a script).
- `test/presentation/runtime-child.test.ts` drives real child sessions through the manager with the
  faux provider and an isolated HOME: background spawn + await + result, `autoAwait`, ask/reply
  intercom, steer delivery to a parked child, cancellation, failed-task resume, and a nested
  `tools.subagent`/`tools.await_subagent` codemode route. A live child is asserted to survive a mode
  switch and still complete. `fork()`/`new session` are not exercised natively (no public session
  API in this harness); branch-scoped preference across replacement is covered by `navigateTree` and
  session reopen plus the mode-contract branch tests.
- Current result: 310 tests / 1214 assertions / 0 failures, package and bench typecheck clean,
  package lint clean, benchmark self-test 9/9.
- The package README is intentionally untouched: the user's checkout has local README edits, so the
  registered-tool table lives in this document instead. README reconciliation is left to the user.

## Measured results (placeholder)

Fill from `bench/subagent-bench.ts` on the same source revision; do not reuse historical estimates.

| Profile | Global codemode | Fresh startup input tokens | Subagent declarations in request | Delegation visible context | Notes |
|---|---|---|---|---|---|
| direct | off | _pending_ | _pending_ | _pending_ | |
| direct | `only`, inlineBudget 3000 | _pending_ | _pending_ | _pending_ | model-only declarations survive `only` |
| codemode | on, inlineBudget 3000 | _pending_ | 0 | namespace note + guardrails | schemas only via discovery |
| codemode | `only`, inlineBudget 3000 | _pending_ | 0 | namespace note + guardrails | |

Historical installed baseline (nine tools, source before this change): 2591 declaration +
537 rule tokens = 3128 tokens. The codemode target is omission/deferred discovery, not a copy of the
same schemas into the codemode description.
