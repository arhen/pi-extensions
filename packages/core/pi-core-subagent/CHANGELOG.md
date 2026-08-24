# Changelog

## Unreleased

- **Model is validated at spawn time, so a bad one refuses the call instead of killing children one by one.** `createRun` now pre-flights every task: it resolves the agent file, applies the file's `model:` override, and resolves + validates that model against the registry BEFORE the run exists. An unresolvable model throws from the tool call with the task named and the override made explicit — e.g. `Task task_1 (api-editor): Model not found: claude-opus-5 (from agent file .../frndos-engineer.md, which overrides the requested model "gpt-5.6-luna")` — and no run, no worktree, and no child session is created. The per-child check stays as a guard.

- **Agent-file matching bound unrelated tasks to the wrong file — and the wrong model.** A ≥ 2 shared-token score with a thin stopword list let filler words decide routing: in a real project four unrelated spawns (`web-editor`, `release-audit`, `code-archaeologist`, `git-statistics`) all matched a PRD-writer file (`web-editor` bound on `from` + `user`). Because a matched file is authoritative it also forced that file's `model: claude-opus-5`, so every child died on turn 1 with `403 MODEL_NOT_IN_PLAN` for a model the leader never requested. Scoring now needs distinct shared terms AND ≥20% coverage of the description, and the stopword list drops generic connectors/verbs.
- **The widget showed the requested model, not the one actually used.** `task.model` kept the leader's request while the agent file's `model:` silently won, so a 403 named a model that appeared nowhere in the UI. The resolved model is now recorded as soon as it resolves.
- **A matched agent file is now named in the per-task notice**, not only in the run summary — a failing task never reaches the summary, which is exactly when knowing "a file overrode your prompt and model" matters most.

- **`tasks: [...]` calls no longer die on leftover top-level `agent`/`task`.** The mode check counted single/tasks/chain and demanded exactly one, so a well-formed 3-task parallel call that still carried a stray `agent`+`task` (models routinely leave them in place when switching shapes) was rejected with "Provide exactly one subagent mode" — after the widget had already rendered the 3 tasks, making it look like a valid call that died. An array mode now wins over the stray single; only `tasks` AND `chain` together is still refused, and the no-mode error lists all three shapes.

- Fifth review round (regression pass on the round-4 fixes + first review of the never-touched modules):
  - **CRITICAL: `bootId()` floored wall time and uptime separately.** `Math.floor(Date.now()/1000) - Math.floor(uptime())` flips by ±1 around integer seconds, so a marker written at second N could read as dead on a read at second N+1. A second pi session opening the same repo then **mid-committed a live, running child's half-finished state and `worktree remove --force`d the checkout under it**. Single floor over expressed seconds.
  - `clearRuns` could resurrect a run after it was cleared: resolving a pending reply made the resumed `onAskParent` closure flip a still-`awaiting_parent` task back to `running` and **re-insert the run into `runs` after `runs.clear()`** — a ghost run the widget re-armed on and persisted forever. All non-terminal tasks are now aborted before pending replies resolve.
  - `reapDeadWorktrees` now drops git-unreadable half-created worktree dirs (timed-out `worktree add`) instead of retrying them forever; `sweepStale` reaps empty run dirs and their stray `.owner` markers.
  - `collectParked` cap eviction: drop the **oldest non-ask** before overwriting the tail, so two asks on a capped entry don't hang the earlier asker.
- First external review of the never-touched modules:
  - `agentfile.ts`: added `MAX_BODY_CHARS` (64K) — an oversized agent file no longer blows the child's context with a cryptic error; added `path` to the match and surfaced it in the run summary so the leader can audit which file won; per-cwd walk memoization (the 3-sync-stats × ancestors × tasks cost).
  - `manager.ts` `persist()`: write-then-rename instead of a plain `writeFile` (a crash mid-write silently dropped the whole run history on next read).
- 1 new test (boot-id marker stability), 9 agentfile tests unblocked by a shared-session cache clear hook (90 total).

- Fourth review round (both halves reviewed externally; the intercom layer for the first time) — worktree fixes:
  - **The ownership marker was being committed into every branch**: `.subagent-owner` lived inside the checkout, so `add -A` staged it — `"empty"` could never be returned, `changedFiles`/diffstat were polluted, and merging carried the pid file into `main`. The marker now lives beside the checkout (`<dir>.owner`).
  - **A failed `worktree list` meant "nothing is registered"**, so `sweepStale` deleted every subagent dir — live ones included — and `cleanupMerged` lost its live-checkout guard. The listing now returns `undefined` on failure and both callers bail out; `-z` falls back to the newline form for git < 2.36.
  - **`--path-format=absolute` (git ≥ 2.31) failed silently**, disabling isolation and all cleanup forever; now falls back to resolving the relative `--git-common-dir`.
  - **Commit could hang the extension**: no timeout, no `maxBuffer`, and gpg signing could block on a passphrase prompt. All git calls are now bounded, with `commit.gpgsign=false` and an identity fallback for machines without `user.email`.
  - **pid reuse**: the marker now records host + boot id, and `EPERM` (process owned by another user) counts as alive rather than dead.
  - `branchDiff` failures no longer masquerade as lost commits; a worktree problem goes to a separate `worktreeError` field so a completed task still shows its answer; empty commits no longer advertise a branch to merge.
  - `commitIn` refuses when the child moved HEAD off its branch; `cleanupMerged` deletes the branch before removing the dir; `worktree add` branches from the recorded base SHA; `..foo` no longer reads as "outside the repo"; a gitignored task `cwd` is created inside the worktree instead of failing session start.
  - **Isolation can no longer lapse silently**: `isolation: "worktree" | "in-place"` plus a reason is reported in the summary and in `subagent_result`.
- Fourth review round — intercom fixes:
  - **A late `ask_parent` could resurrect a finished task** (`aborted` → `awaiting_parent` → `running`), leaving a live task inside a terminal run so `hasActiveRun()` never cleared. Terminal tasks are now refused up front and after the wait — which also makes **cancel authoritative** over a reply that lands in the same tick.
  - **Only the first ask was surfaced** by autoAwait: siblings that asked during the same wake had their notice swallowed by the park and blocked for the full 10-minute timeout. Every ask is now listed with its own `reply_subagent` line.
  - **The 24-message park cap silently dropped asks and completions** while reporting them as delivered; asks now displace a buffered message and an undeliverable message falls back to the followUp path.
  - **Two concurrent awaits on one run** overwrote each other's buffer (one side got no intercom, and the first `finish()` unparked both); parks are now a set with per-entry cleanup.
  - `clearRuns()` no longer leaves parked awaits pending forever; two asks from one child no longer delete each other's pending entry; a timed-out slice no longer suppresses the run's completion notice; leftover non-terminal tasks are swept when the wave loop ends.
- 6 new regression tests: marker never committed, HEAD-moved refusal, reply consumed once, clearRuns releasing awaits (89 total).

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
