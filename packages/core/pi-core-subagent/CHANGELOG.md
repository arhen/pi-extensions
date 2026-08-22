# Changelog

## Unreleased

- Named agent files supported: an `agent` name matching `<name>.md` in `.agents/agents`, `.claude/agents`, or `.pi/agents` (task `cwd` ancestors, then home) loads that file — body = system prompt, frontmatter `model`/`tools` apply, file `model` validated against the pi model registry. Lookup order: project `.agents` (single source) → `.claude` → `.pi`, nearest ancestor first; then `~/.agents` → `~/.claude` → `~/.pi`. Inline `prompt`/`model`/`tools`/`write` override the file. Files without frontmatter work (whole file = prompt).
- New `src/agentfile.ts` + 9 resolution-order tests. README "no agent files" claims replaced with the real spec.
- Breaking: blocking mode removed — every run is background. `background:false` and the `/subagents auto-bg` toggle are gone; use `autoAwait:true` on the spawn for an inline result (same background machinery, parks the tool call until the run finishes).
- `autoAwait` param added to `subagent`: background start + park until done, runId + final result in one response. Children can still ask_parent while the leader is parked (drained via await_run).
- Intercom: removed the blocking-run dead-end ("parent cannot answer, continue autonomously") — ask_parent always waits for a real reply.
- `Run.background` / `RunDetails.background` fields removed; makeSummary no longer tags "(background)".

## 1.3.4

- Refactor: `index.ts` split into `graph.ts` (scheduler), `format.ts` (rendering), `manager.ts` (lifecycle), `schemas.ts` (tool schemas), `types.ts`.
- Wave scheduler extracted as pure `runWaveScheduler` — tests exercise the real loop, not a mirror (broken-upstream skip + canceled-upstream paths now covered).
- Manager tests: `cancelRun`/`cancelTask` state transitions, `awaitRun` settle semantics.
- runChild event handling extracted into `onChildEvent`; `scheduleWidget` dead param removed; `persist` uses async `writeFile`; `eventSeq` moved into the manager.
- Tooling: `check`/`lint`/`typecheck`/`test` scripts, Biome config (lineWidth 120), CI workflow, README CI badge, CHANGELOG.
- `await_subagent` timeout race: settled-wins now sets `awaited` so the redundant completion notice is suppressed.
- `MailboxMessage` single definition (was duplicated in `child.ts` and `mailbox.ts`).

## 1.3.3

- `poll_agent_messages` dump capped at 4000 chars, multibyte-safe (was returned uncapped).
- `await_subagent` timeout resolves with a snapshot; the completion notice still fires on settle.
- `notifyPerTask` enforced background-only (blocking runs can't be woken mid-tool).
- Task input types derived from TypeBox schemas via `Static` (no hand-maintained mirror).
- `tools` allowlist exposed in single-mode `subagent` schema (was accepted but never sent).
