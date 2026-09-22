---
name: deliberate-plan
description: Research-first implementation plan from a configured read-only subagent, saved as standalone Markdown to the configured path. Use when the user runs /plan or asks for an implementation plan without implementation.
---

# Deliberate Plan

Produce a standalone Markdown implementation plan. Never implement anything and never edit repository files. The only write allowed is `deliberate_save_plan`.

## Protocol

1. **Always call `deliberate_mode` first** with:

   ```json
   { "mode": "plan", "action": "prepare" }
   ```

2. Branch on `status`:
   - **`unconfigured`** — state that plan mode is skipped and tell the user to run `/deliberate-config plan`. Stop: do not spawn a subagent, and do not plan as the main agent.
   - **`dependency-missing`** — state that the `subagent` tool is missing or inactive and to install/enable `@arhen/pi-core-subagent`. Stop.
   - **`model-unavailable`** — follow [Failure handling](#failure-handling).
   - **`ready`** — continue; `path` is the configured output path (the parent never chooses it).

3. Make **exactly one** `subagent` call, single-agent mode, with explicit config:

   ```json
   {
     "agent": "deliberate-plan",
     "prompt": "<inline system prompt below>",
     "task": "<goal + supplied extra context + relevant current-session context>",
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

4. The result must be a plan only: never implement, never edit files, never run write commands.

## Inline subagent prompt

> You are a planning specialist. Inspect the repository read-only and produce a standalone Markdown implementation plan for the supplied goal. Never implement, edit, or write files. Use exactly these sections, in order:
>
> 1. **Goal**
> 2. **Context / assumptions**
> 3. **Constraints**
> 4. **Steps** — numbered; each step names the files/symbols to change and why
> 5. **Tests / checks** — exact commands that verify each step
> 6. **Risks**
> 7. **Open questions**
>
> Cite concrete paths and symbols. Keep the plan self-contained: no references to the conversation.

## Saving

The tool owns the path. After any successful plan path:

- Call `deliberate_save_plan({ "markdown": "<final standalone Markdown>" })`.
- Never pass or invent a path; the configured path comes from the tool.
- Report the saved path and tell the user to view it with `/plan-view` (Ctrl+Alt+P).

## Failure handling

When prepare returns `model-unavailable`, or the child fails with an auth/quota/model/runtime error, call `ask_user_question` with exactly these four options:

- `Skip mode`
- `Custom subagent`
- `Reconfigure mode`
- `Main agent handles`

Handle the answer:

- **`Skip mode`** — stop; no plan is produced.
- **`Custom subagent`** — call the normal `subagent` tool without the deliberate config. Do not reuse the failed model unless the user explicitly asks. After it returns, save the final plan with `deliberate_save_plan`.
- **`Reconfigure mode`** — call `deliberate_mode` with `{"mode":"plan","action":"configure"}`, then retry `prepare` once. If it is still not `ready`, stop and report.
- **`Main agent handles`** — research the repository read-only and write the plan yourself, then save it with `deliberate_save_plan`.

If `ask_user_question` is not available, ask the same four options as plain text and stop until the user answers.
