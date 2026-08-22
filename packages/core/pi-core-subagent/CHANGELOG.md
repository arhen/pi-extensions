# Changelog

## Unreleased

- Third review round — worktree fixes:
  - **cwd mapping**: dropping the worktree for an out-of-repo cwd left `childCwd` pointing at the just-removed dir; `wt.root` wasn't realpathed, so any symlinked cwd (`/var` vs `/private/var`) looked "outside" and triggered it.
  - **Concurrent pi sessions**: "nothing of ours is live at session start" was false — session B committed half-written files onto session A's branch and force-removed A's live checkout. Worktrees now carry a `.subagent-owner` pid marker; reap/sweep/cleanup skip dirs whose owner is alive.
  - **Unreachable work**: a commit *throw* (index.lock, missing `user.email`, ENOENT) was treated as "nothing to commit" and the dir was dropped anyway — the base-tip branch was then reaped as merged and the work was gone. `commitWorktree` returns `committed | empty` and throws keep the dir.
  - **Leak past early return**: the worktree was created before model resolution, so an unknown model leaked both the checkout and its `liveWorktrees` entry (poisoning cleanup forever). Model resolution runs first now; `clearRuns()` also clears the map.
  - **`.git` as a FILE** (linked worktree / submodule): `worktree add` threw and isolation silently fell back to in-place edits — now resolved via `--git-common-dir`.
  - **Porcelain paths**: the `unquote()` helper was unnecessary (git doesn't C-quote there) and byte-wrong, and could delete a live checkout; replaced with `worktree list --porcelain -z`.
  - Nested `node_modules` excluded from commits; `liveWorktrees` entry released only after the dir is gone; leader-supplied `tools` filtered like agent-file tools.
- Third review round — intercom/await fixes:
  - **Unanswered `ask_parent` no longer pins a run open forever**: the wait is capped (10 min) and resolves with a proceed-autonomously instruction; the two duplicate ask branches are now one path.
  - **Cancel releases parked children**: `cancelRun`/`cancelTask` resolve pending replies (a child waiting on an answer used to outlive the abort); a late `reply_subagent` correctly reports no pending question.
  - **Settler chain replaced with a waiter set**: the autoAwait re-park loop wrapped the previous settler on every child message, growing an unbounded closure chain of snapshot clones.
- 8 new regression tests: `.git`-as-file isolation, ownership marker vs reaping, commit-throw keeps the dir, multi-awaiter settle, cancel releasing a parked ask (85 total).

- Second review pass (re-review of the hardening commit) — fixes:
  - **`canWrite` derived from the delivered toolset** (was: raw request). `tools: ["bash"]` without `write:true` now gets a worktree; a file that narrowed the child to read-only no longer gets a bogus branch/commit/merge ceremony.
  - **Parked `ask_parent` now registers a pending reply** — previously the child was told "the answer arrives via the pending reply" while no entry existed, so `reply_subagent` failed with "No pending question" and the answer was lost.
  - **`autoAwait` accumulates intercom across parks** (each park allocates a fresh buffer, so every wake but the last was dropped) and reports notifies alongside the summary.
  - **`notify_parent` / `send_agent_message("leader")` no longer gated on `run.awaited`** — between two parks the leader was "awaited" but listening, and messages vanished.
  - **Crash recovery actually works**: `reapDeadWorktrees` at session start commits an interrupted child's uncommitted work, keeps the branch, drops the dir. Registered-but-dead worktrees were previously skipped by both cleanup paths and leaked forever (incl. the model-resolution early return, which no longer leaks).
  - **`sweepStale` path matching fixed**: git C-quotes porcelain paths, so a repo path containing a space bypassed the live-worktree guard and could delete a running child's checkout; paths are now unquoted and compared through realpath.
  - **`cleanupMerged` re-checks checkout state per branch** (stale snapshot could delete a worktree created mid-loop) and accepts `skipBranches` — branches owned by live runs are never touched. It also runs once per repo, wrapped, so a cleanup error can't re-settle a finished run as failed.
  - **Empty-commit bug**: the dirty check counted the untracked `node_modules` symlink, so a no-op task "failed" its commit and reported a branch with no commits. Staging is now checked instead.
  - Failure path waits briefly for an aborted child's last writes before committing partial work; `cwd` outside the repo drops the worktree instead of silently writing in the main tree; `removeByBranch` requires the `subagents/` prefix; unreachable id lookup fails the task instead of leaving it queued forever; `timeoutMs: 0` no longer parks forever.
- 4 new regression tests: `skipBranches` ownership, node_modules-only no-op commit, crash reaping, live worktree in a repo path with a space (80 total).

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
