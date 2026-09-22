# @arhen/pi-add-deliberate

[![npm version](https://img.shields.io/npm/v/@arhen%2Fpi-add-deliberate?color=cb3837&logo=npm)](https://www.npmjs.com/package/@arhen/pi-add-deliberate)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Configured **advise** and **plan** modes for the [pi coding agent](https://github.com/earendil-works/pi). Both delegate to a read-only subagent through the installed [`@arhen/pi-core-subagent`](https://www.npmjs.com/package/@arhen/pi-core-subagent) extension — this package never spawns child sessions itself.

- **`/advise [extra context]`** — evidence-based second opinion: best practices, common patterns, efficient approaches, deeper analysis.
- **`/plan [extra context]`** — research-first implementation plan; never implementation. The final standalone Markdown is saved to the configured path.
- **`/plan-view`** or **`Ctrl+Alt+P`** — open the saved plan in a scrollable overlay (or print its path outside the TUI).
- **`/deliberate-config [advise|plan|status|clear]`** — pick the model, thinking level, tools, and plan path.

## Install

Requires pi and `@arhen/pi-core-subagent`:

```sh
npm install -g @earendil-works/pi-coding-agent
pi install npm:@arhen/pi-core-subagent
pi install npm:@arhen/pi-add-deliberate
```

## Config

Stored at `${getAgentDir()}/deliberate.json` (usually `~/.pi/agent/deliberate.json`) and strictly validated on read: unknown keys, wrong types, or invalid values make the whole config unconfigured.

```json
{
  "advise": {
    "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
    "thinking": "high",
    "tools": ["read", "grep", "find", "ls", "bash"]
  },
  "plan": {
    "model": { "provider": "openai", "id": "gpt-5" },
    "thinking": "medium",
    "tools": ["read", "grep", "find", "ls"],
    "path": "PLAN.md"
  }
}
```

- `model`, `thinking`, and `tools` are optional; `path` is plan-only.
- Tools are filtered to the mode's read-only allowlist: advise `read, grep, find, ls, bash`; plan `read, grep, find, ls`. `edit` and `write` are never allowed. Defaults are the full allowlists.
- `path` may be relative to the current cwd, `~/...`, or absolute; default `PLAN.md`.
- The model picker lists session-scoped models (`--models` / `enabledModels`) when configured, otherwise every currently available (authenticated) model. Thinking options come from the model's supported levels.
- Writes are atomic (temp file + rename), so a crash never leaves a half-written config.

## How a run works

1. `/advise` or `/plan` injects `/skill:deliberate-advise ...` / `/skill:deliberate-plan ...` as a user message (queued as a follow-up when the agent is busy). The matching skill command must exist, checked via `pi.getCommands()`.
2. The skill always calls `deliberate_mode` with `action: "prepare"` first:
   - `unconfigured` — skipped; the skill points to `/deliberate-config <mode>` and stops. No session-model fallback.
   - `dependency-missing` — the `subagent` tool is missing or inactive.
   - `model-unavailable` — the configured model is not loaded, or a 16-token preflight call fails (auth/quota/provider).
   - `ready` — returns the exact provider/model ref, the configured supported thinking level, the filtered tools, and (plan) the resolved path.
3. Only then does the main agent make exactly one `subagent` call with `model`, `thinking`, `tools`, `write: false`, the mode's inline prompt, and `autoAwait: true`.
4. On a model failure the skill asks (`ask_user_question` when available): `Skip mode`, `Custom subagent`, `Reconfigure mode`, or `Main agent handles`.
5. After any successful plan — deliberate subagent, custom subagent, or main agent — the main agent calls `deliberate_save_plan` with the final Markdown. The model never chooses the path.

## Tools

| Tool | Purpose |
| --- | --- |
| `deliberate_mode` | `prepare` (validate config/subagent/model/connectivity) or `configure` (picker UI, save config; non-UI returns `configure-requires-ui`) |
| `deliberate_save_plan` | Save final Markdown to the configured path, atomically, and record it in the session; rejects empty content |

## Saved plan state

The latest `deliberate-plan` custom entry on the current session branch is restored on `session_start` and `session_tree`, rebuilding the widget (`path`, `/plan-view`, `Ctrl+Alt+P`) and footer status. `/plan-view` re-reads the file from disk; a missing file warns, and a saved path that differs from the current config is flagged as stale. The overlay uses a manual sliced viewport with `↑/↓`, `PgUp/PgDn`, `Home/End`, `Esc`/`q`, and SGR mouse-wheel scrolling when the terminal forwards it.

## Limitations

- The advise/plan subagents are read-only; they cannot run write tools or save plans themselves.
- The preflight consumes a minimal request (`maxTokens: 16`) against the configured model each time `prepare` runs.
- Mouse-wheel scrolling only works when the terminal emits SGR wheel events to the regular (non-alt-screen) TUI; keyboard scrolling always works.
- `deliberate_mode configure` and `/deliberate-config` require interactive UI.

## License

MIT.
