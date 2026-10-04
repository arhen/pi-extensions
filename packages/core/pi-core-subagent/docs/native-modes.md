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
  effect at the next request boundary and never cancel or restart a run.

## Safety invariants

- No global or project settings, codemode settings, version numbers or installed packages are
  changed. `codemode` is never enabled behind the user's back.
- The active tool selection is preserved; unrelated tool names are never added or removed, and
  `setActiveTools` is not used to force subagent tools on.
- Explicit `--tools`/`defaultTools` allowlists and `noTools` continue to decide whether the subagent
  tools are registered/reachable at all.

## Verification

- `bun run typecheck && bun run lint && bun test` in `packages/core/pi-core-subagent`.
- `test/presentation/mode-contract.test.ts` pins the exposure, hiding, command, persistence and
  selection-preservation contract with a harness that mirrors `_applyToolLoadout`.
- `test/presentation/runtime.test.ts` runs real Pi 1.0.1 sessions with the native codemode extension
  (modes `on` and `only`, `inlineBudget: 3000`) and a faux provider: declaration capture, discovery
  through the QuickJS sandbox, nested validation, allowlist behavior and session reopen.
- Current result: 237 tests / 922 assertions / 0 failures (26 new presentation tests).

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
