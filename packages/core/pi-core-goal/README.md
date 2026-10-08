# @arhen/pi-core-goal

Session-log-backed long-running objective mode for pi. One goal per thread; the agent keeps continuing automatically until the goal is complete, blocked, paused, or out of budget. Temporary provider usage limits queue a background retry instead of requiring manual intervention.

## Usage

```text
/goal <objective>     → set and start a goal
/goal                 → show current goal + usage
/goal edit            → edit the objective (TUI)
/goal pause|resume    → stop/start automatic continuation
/goal clear           → remove the goal
```

Tools exposed to the agent: `create_goal`, `get_goal`, `update_goal` (complete/blocked only). `create_goal` refuses while an unfinished goal exists.

The statusline mirrors the goal: `Pursuing goal (…)`, `Goal paused (/goal resume)`, `Goal budget reached`, `Goal hit usage limits (auto-retry at …)`, `Goal complete`. `/goal` and `get_goal` expose the next retry time and attempt number.

## Automatic quota recovery

- Session, weekly, monthly, and other temporary provider limits queue one background retry. No shell subprocess or model call runs while waiting.
- Reset timestamps, `Retry-After`, relative hints such as `Try again in ~123 min`, and clock hints such as `resets 5pm (Asia/Jakarta)` determine the retry time, with a 30-second grace period and a minimum one-minute wait. Clock hints use the stated timezone, or the machine's local timezone when none is given, and select the next occurrence. Unusable hints fall back safely. Without a usable hint, retries back off through 5, 10, 20, 40, then 60 minutes.
- If the retry hits another limit, it queues again automatically. A successful turn resets the backoff. Pi's built-in retries and compaction finish before goal recovery is scheduled.
- `/goal pause`, `/goal clear`, replacement, completion, blocked status, or token-budget exhaustion cancels the retry. `/goal resume` retries immediately. Sending a new message also resumes the waiting goal.
- Keep Pi open for unattended progress. Retry state survives reloads and reopening the session; overdue retries run when that session is idle again. Closing Pi stops execution until the session is reopened.
- Context overflow, authentication, and billing/credit errors do not enter an endless quota-retry loop.

## Design

- State lives in the session log (`appendEntry`, `version: 2` entries with actions `set | edit | status | clear | account`), reconstructed on reload/tree navigation. Optional `usageRetry` metadata stores `{ attempt, retryAt }`, where `retryAt` is a Unix timestamp in milliseconds. Old entries remain compatible. No external files.
- Continuation is queued on `agent_settled` — after retries, compaction, and queued messages have fully drained — never mid-pipeline. Each continuation carries a delivery ID acknowledged by `message_start`. An unacknowledged message is resubmitted after one minute once Pi is idle with no other pending messages, covering asynchronous `sendMessage` failures without relying on a synchronous exception.
- The system-prompt injection is static per goal (objective + rules only). Usage numbers travel in the continuation message at the end of the context, so the provider prompt-cache prefix stays stable across goal turns. Use `get_goal` for live numbers.
- Optional `token_budget` (positive integer) stops automatic continuation when exhausted; objectives are capped at 4,000 characters.
- A provider usage/rate/quota error flips the goal to `usageLimited` only after the run settles. A cancellable, session-scoped timer resumes it and queues continuation when due, deferring while Pi is busy or has pending messages. Time spent waiting for quota reset is not counted as active goal time. Aborting a goal turn, including during Pi's native retry backoff, asks to pause the active goal (or pauses directly without UI).
- Strict completion and blocked audits in the continuation prompt: complete only with requirement-by-requirement evidence; blocked only after the same blocker repeats for 3 consecutive goal turns.

## Test

```bash
bun test
```
