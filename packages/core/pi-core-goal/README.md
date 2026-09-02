# @arhen/pi-core-goal

Session-log-backed long-running objective mode for pi. One goal per thread; the agent keeps continuing automatically until the goal is complete, blocked, paused, or out of budget.

## Usage

```text
/goal <objective>     → set and start a goal
/goal                 → show current goal + usage
/goal edit            → edit the objective
/goal pause|resume    → stop/start automatic continuation
/goal clear           → remove the goal
```

Tools exposed to the agent: `create_goal`, `get_goal`, `update_goal` (complete/blocked only).

## Design

- State lives in the session log (`appendEntry`), reconstructed on reload/tree navigation. No external files.
- Continuation is queued on `agent_settled` — after retries, compaction, and queued messages have fully drained — never mid-pipeline.
- The system-prompt injection is static per goal (objective + rules only). Usage numbers travel in the continuation message at the end of the context, so the provider prompt-cache prefix stays stable across goal turns. Use `get_goal` for live numbers.
- Optional `token_budget` stops automatic continuation when exhausted.
- Strict completion and blocked audits in the continuation prompt: complete only with requirement-by-requirement evidence; blocked only after the same blocker repeats for 3 consecutive goal turns.

## Test

```bash
bun test
```
