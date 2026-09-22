---
name: deliberate-advise
description: Evidence-based second opinion from a configured read-only subagent. Use when the user asks for a second opinion, best practices, common patterns, an efficient approach, or deeper analysis before acting, or when they run /advise.
---

# Deliberate Advise

Give the user a critically synthesized second opinion from a configured read-only subagent.

## Protocol

1. **Always call `deliberate_mode` first** with:

   ```json
   { "mode": "advise", "action": "prepare" }
   ```

   Never spawn a subagent before prepare returns. Never substitute the session model for a missing config.

2. Branch on `status`:
   - **`unconfigured`** — state that advise mode is skipped and tell the user to run `/deliberate-config advise`. Stop: do not spawn a subagent, and do not answer as the main agent.
   - **`dependency-missing`** — state that the `subagent` tool is missing or inactive and to install/enable `@arhen/pi-core-subagent`. Stop.
   - **`model-unavailable`** — follow [Failure handling](#failure-handling).
   - **`ready`** — continue with the payload's exact `model`, `thinking`, and `tools`.

3. Make **exactly one** `subagent` call, single-agent mode, with explicit config:

   ```json
   {
     "agent": "deliberate-advise",
     "prompt": "<inline system prompt below>",
     "task": "<question + supplied extra context + relevant current-session context>",
     "model": "<model from prepare>",
     "thinking": "<thinking from prepare>",
     "tools": ["<tools from prepare>"],
     "write": false,
     "autoAwait": true
   }
   ```

   - `write: false` is mandatory.
   - `autoAwait: true` is mandatory: consume the result in this same turn.
   - Include the user's extra context and the relevant current-session context (goal, constraints, decisions already made, files/symbols under discussion) in `task`.
   - Do not use `tasks`, `chain`, or `needs`; one agent, one call.

4. Critically synthesize the result. Never blindly relay the child's answer: verify its claims against the repository, flag disagreements or weak evidence, and give your own recommendation.

## Inline subagent prompt

> You are an evidence-based expert giving a second opinion. Inspect the repository and the supplied context read-only. Identify the actual question, compare realistic options and their tradeoffs, recommend one with reasoning, and list risks and unknowns. Cite files and symbols as evidence. Make no file changes: do not edit or write files, do not write code, and do not save plans.

## Failure handling

When prepare returns `model-unavailable`, or the child fails with an auth/quota/model/runtime error, call `ask_user_question` with exactly these four options:

- `Skip mode`
- `Custom subagent`
- `Reconfigure mode`
- `Main agent handles`

Handle the answer:

- **`Skip mode`** — stop; do not produce an advise run.
- **`Custom subagent`** — call the normal `subagent` tool without the deliberate config. Do not reuse the failed model unless the user explicitly asks for it.
- **`Reconfigure mode`** — call `deliberate_mode` with `{"mode":"advise","action":"configure"}`, then retry `prepare` once. If it is still not `ready`, stop and report.
- **`Main agent handles`** — answer the question directly in this session as the second opinion.

If `ask_user_question` is not available, ask the same four options as plain text and stop until the user answers.
