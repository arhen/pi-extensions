# Changelog

## Unreleased

- Review-driven hardening (external review of the worktree feature):
  - **C1/H1**: `cleanupMerged` never touches LIVE worktrees (concurrent-run safety — a fresh branch's tip equals its base so it looked "merged"); cleanup also runs at session start, so branches the leader merges manually get reaped.
  - **C2/C3**: `autoAwait` surfaces `ask_parent` instead of dropping it (returns the question, leader replies + re-awaits — no hang), and stops instead of busy-spinning when the run is gone (session shutdown).
  - **C4**: scheduler callback now looks inputs up by task id — the old index was into the FILTERED task list but was applied to the unfiltered inputs, handing tasks the wrong prompt/model/tools after a pre-start cancel.
  - **H3**: failed/aborted tasks commit their partial work BEFORE the worktree dir is removed — the branch really keeps it now.
  - **H4/H5**: agent-file `tools` are intersected with the leader's intent (a repo-planted file can narrow, never widen — no silent write escalation); worktree isolation applies whenever the child can write, not only on explicit `write:true`.
  - **H6**: commit/diff failures no longer downgrade a completed task or destroy its work — reported as error, status stays completed.
  - **M1/M2**: task ids validated (`[A-Za-z0-9_-]{1,64}` — they become git refs + paths); generated ids checked against explicit ones for collisions.
  - **M3**: per-task `cwd` subpaths are mapped into the worktree.
  - **M5/M6/M7**: commit excludes `node_modules`; branch base is a SHA (detached HEAD safe); `git worktree prune` on removal.
  - **M4**: session-start sweep uses the repo root + dedupes roots.
- New regression tests: live-worktree cleanup safety, id validation, generated/explicit id collision (76 total).

- **Worktree isolation for write agents**: in a git repo, `write: true` subagents run in an isolated worktree at `<repo>/.git/subagents/<run>/<task>` (branch `subagents/<run>/<task>`) — project AGENTS.md context chain preserved, `node_modules` symlinked, main tree stays clean, parallel writers can't collide. On completion the extension commits the child's changes and reports branch + diffstat + changed files; leader reviews and merges with `git merge --no-ff <branch>`. Merged branches + worktree dirs cleaned automatically; failed/canceled tasks keep the branch (partial work) but drop the dir; crash leftovers swept at session start (dirs removed, branches kept). Non-git repos fall back to in-place.
- Result/notice formats: wake notices and `subagent_result` now carry the task goal (so the leader doesn't lose context across turns) + branch/diffstat for write tasks. `makeTaskNotice` shows goal snippet.
- New `src/worktree.ts` + 7 tests against a real temp git repo.

## 1.3.27

- Agent-file matching is by **description**, not name: the spawn goal (`agent` name + `task`) is token-scored against each file's `description` frontmatter (≥2 shared meaningful tokens, plural/-ing stemmed). A matched file is authoritative — body = system prompt, frontmatter `model`/`tools` win over inline `prompt`/`model`/`tools`. No match → inline on-demand definition unchanged.
- `src/agentfile.ts` rewritten for description matching (was name-based); tests updated to goal-vs-name fixtures.

## 1.3.26

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
