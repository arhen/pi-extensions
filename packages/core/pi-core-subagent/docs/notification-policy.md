# Leader notification policy

Applies to both native exposure profiles. Parent tool signatures, active selections, model choices,
permissions, child isolation, and lifecycle events are unchanged.

## Updates versus final reports

Both child tools coalesce identical leader updates within one task attempt:

```ts
notify_parent({ message: "Found the cause." });
send_agent_message({ to: "leader", message: "Found the cause." });
```

These share an informational delivery key. Distinct content, severity, final/progress phase, tasks,
runs, and resumed attempts remain distinct. Sibling mailbox delivery is unchanged. Questions and
failed/aborted task notices are not filtered by sender-side coalescing.

An ordinary update does **not** suppress eventual completion. Declare a complete final report
explicitly, as the last tool call, then repeat that exact text as the final answer:

```ts
notify_parent({ message: report, final: true });
```

Alternatively:

```ts
send_agent_message({ to: "leader", message: report, final: true });
```

`final` is optional, defaults to false, and affects leader-targeted delivery only. The child guidance
explains this contract. No heuristic interprets words such as “done” or “PASS” as final metadata.

## Held delivery and the outbox

Informational and completion notices are held in an extension-owned outbox instead of being queued
immediately. The outbox is released at a delivery boundary (leader context and agent settlement),
which lets a later event prove a held notice redundant before it is ever submitted:

- a terminal await that returns the task's outcome drops the matching held notice;
- a `subagent_result` call that shows a finished task's full output drops it the same way (reading
  the result is consumption; tasks cut off by the output cap stay uncovered);
- a confirmed report suppresses its redundant task/run completion prompts;
- a covered outcome from any terminal state (completed, failed, aborted) suppresses a duplicate
  aggregate entry for the same outcome.

Failures keep interrupting the leader: a failed task or run notice is submitted as a steering
message immediately, because the leader must decide (resume, swap model, respawn) before continuing.
Aborts, completions, and informational updates are held, then delivered as follow-ups.

Everything releasable at one boundary leaves as **one** leader message:
`N subagent notices since your last turn:` followed by each notice body verbatim (a single notice is
sent as-is). Each notice would otherwise cost its own leader turn — a full model call over the
whole context — and Pi would run the prompts one behind the other. Receipts are still per notice:
each body confirms on its own inside the batch.

## Receipts

A tool response saying **submitted** means submission was accepted, not that the model consumed it.
Pi's extension `sendUserMessage` API returns void; asynchronous rejection is reported by Pi, not
returned to the child handler.

Receipts are confirmed against **canonical session state**: the finalized leader projection
(`sessionManager.buildSessionProjection()`), not an intermediate `message_end` object. A later
handler that rewrites or redacts the message therefore leaves the receipt unconfirmed, and the held
fallback still fires. A surrounding input wrapper is permitted as long as the complete notification
body remains intact.

Confirmation proves transcript receipt, **not model consumption** or permanent retention after
compaction, branch changes, request-local context transformations, or later edits.

A successful final report suppresses redundant task/run success prompts only when:

- its text hash equals the child's final answer (computed before display truncation, so reports
  larger than the 24-KiB cap still match);
- no further tool work occurred after the latest declared final report;
- delivery was confirmed, or completion is deferred while that report remains pending.

Artifact notices compare an artifact fingerprint (branch, sorted changed files, diffstat, commit
error) captured with the report against the task's final state. Static metadata such as
`isolation: "in-place"` without a diff is not a delta; genuinely new commits, changed files, and
commit errors are. Artifact prose is never parsed semantically.

Changed final text, additional tool work, failures, cancellations, and questions remain visible.
Aggregates list only tasks not already covered by a report, a per-task notice, or an awaited result.

## Loss, retry, and fallback

A receipt that is submitted but never appears in the canonical context is treated as **lost** when
the leader is idle and either:

- Pi **accepted** it (the subagent extension's `input` handler saw the body, so it left Pi's prompt
  queue) and it is still missing from the canonical context 3 seconds later — it was dropped or
  rewritten; or
- Pi **never accepted** it and the leader has stayed idle for 30 seconds — its prompt threw before
  the input stage (for example during compaction).

"Another agent run started" is **not** evidence of loss. Prompts submitted during `agent_settled`
are deferred and run one after another, and the leader looks idle between them, so a notice can sit
in Pi's queue behind other prompts (goal continuations, user input, earlier notices) for as long as
those runs take. Earlier versions treated a later run plus 3 s as loss, which resubmitted every
queued notice and flooded the leader with repeats. Receipts are recorded before `sendUserMessage`,
because an idle leader runs the input stage synchronously inside that call.

- A lost notice is re-queued automatically for up to `MAX_DELIVERY_ATTEMPTS` (3) total submits, then
  the receipt is declared lost: a final report releases its per-task hold or a direct full fallback,
  and a run-level watch releases the aggregate retry once every terminal receipt for the run has
  resolved (delivered or lost). Aggregate retry stays bounded to one per run.
- A lost update is re-queued on the same budget; a pending (not yet lost) update is still coalesced.
- Synchronous submission failures stay in the outbox with a bounded retry backoff (three attempts,
  one second apart). Pi reports asynchronous `sendUserMessage` rejections through its own error
  channel, so those surface as lost notices rather than as a retry loop here.

Await coverage is per task: `markAwaitCoverage` receives the IDs the rendered summary (or
`subagent_result` output) actually covered, and only terminal notices or final reports whose text matches the awaited result are
dropped. Updates and reports cut off by the 24-KiB summary cap are still delivered.

## State and limits

Received update history is released once its child has ended. Pending outbox entries, delivery
records, and compact completion bookkeeping remain session-local until resolved, resumed, or
cleared. Resume resets that task's report/dedup coverage. Existing sidecar snapshots retain
final-report metadata, but pending outbox entries are not reconstructed and historical runs are not
replayed on reload.

This is not an exactly-once transport or a retry broker for every progress, failure, or ask message.
Held delivery is bounded to the next leader boundary: a notice held while the leader runs is
submitted when that run settles, and a notice held while the leader is idle is submitted on the next
flush. Existing steering/follow-up routes remain in force.

No global settings, installed packages, package versions, or publication are changed by this patch.
Earlier startup/delegation benchmarks used their frozen sources and predate this delivery policy;
this work makes no new token, latency, or monetary-savings claim.

## Verification

Tests were added and reproduced failures before the corresponding implementation changes.
`test/notification-dedup.test.ts` covers shared keys, held delivery, canonical receipts, wrapped and
redacted bodies, the loss grace period and retry backoff, severity/phase/task boundaries, new
results/work/artifacts, await and `subagent_result` coverage, aggregate coverage across terminal
states, oversized-report fingerprints, batching, queued-vs-accepted loss, and receipt-history cleanup.

`test/presentation/notification-flood.test.ts` reproduces the live flood with real Pi sessions: three
final reports held while the leader is busy, each leader turn taking 3.5 s, must arrive once each in
one message (before the fix: 6 notice messages and 8 leader turns), and reports the leader already
read with `subagent_result` must not arrive at all.

`test/presentation/runtime-child.test.ts` uses real Pi sessions and a faux provider: busy-parent
queues with either `notifyPerTask` mode, shared progress deduplication, a stripped report with an
exactly-once fallback, inline echoes, and a large truncated summary. No live benchmark campaign or
installed-package update was used to verify this policy.

Run from `packages/core/pi-core-subagent`:

```sh
bun test
bun run typecheck
bun run lint
bunx tsc --noEmit -p bench/tsconfig.json
bun bench/subagent-bench.ts --self-test
bun bench/subagent-repeat-bench.ts --self-test
```
