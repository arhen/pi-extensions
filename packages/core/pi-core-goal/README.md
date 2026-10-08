# @arhen/pi-core-goal

Session-log-backed long-running objective mode for pi. One goal per thread; the agent keeps continuing automatically until the goal is complete, blocked, paused, usage-limited, or out of budget.

## Usage

```text
/goal <objective>     → set and start a goal
/goal                 → show current goal + usage
/goal edit            → edit the objective (TUI)
/goal pause|resume    → stop/start automatic continuation
/goal clear           → remove the goal
```

Tools exposed to the agent: `create_goal`, `get_goal`, `update_goal` (complete/blocked only). `create_goal` refuses while an unfinished goal exists.

The statusline mirrors the goal: `Pursuing goal (…)`, `Goal paused (/goal resume)`, `Goal budget reached`, `Goal hit usage limits (/goal resume)`, `Goal complete`.

## Design

- State lives in the session log (`appendEntry`, `version: 2` entries with actions `set | edit | status | clear | account`), reconstructed on reload/tree navigation. No external files.
- Continuation is queued on `agent_settled` — after retries, compaction, and queued messages have fully drained — never mid-pipeline.
- The system-prompt injection is static per goal (objective + rules only). Usage numbers travel in the continuation message at the end of the context, so the provider prompt-cache prefix stays stable across goal turns. Use `get_goal` for live numbers.
- Optional `token_budget` (positive integer) stops automatic continuation when exhausted; objectives are capped at 4,000 characters.
- A provider usage/rate/quota error stops continuation and flips the goal to `usageLimited` — `/goal resume` restarts it. Aborting a goal turn asks to pause the active goal.
- Strict completion and blocked audits in the continuation prompt: complete only with requirement-by-requirement evidence; blocked only after the same blocker repeats for 3 consecutive goal turns.

## Test

```bash
bun test
```
