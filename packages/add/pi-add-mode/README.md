# @arhen/pi-add-mode

Named **modes** for [pi](https://github.com/earendil-works/pi): each mode bundles an extra instruction block, a tool set,
a model, a subagent model and a colour. Create modes once, then switch the whole setup with `/mode` or `ctrl+tab`
instead of changing model/tools/instructions by hand at every session start.

## Install

```bash
pi install npm:@arhen/pi-add-mode
```

## Use

| Command | Effect |
| --- | --- |
| `/mode` | Open the mode panel: list, enable/disable, create, edit, delete, activate |
| `/mode <name>` | Activate a mode directly |
| `/mode off` | Back to the built-in default mode |
| `/mode new` | Create a mode |
| `/mode edit` | Edit a mode (picks from a list) |
| `/mode list` | Print modes with enabled/active state |
| `ctrl+tab` / `ctrl+shift+tab` | Cycle forward/back over **enabled** modes (default first) |
| `alt+m` | Cycle forward (fallback for terminals that cannot report `ctrl+tab`) |

Enable ≠ activate: `space` in the panel toggles whether a mode is in the `ctrl+tab` rotation; `enter` (or
`/mode <name>`) activates it. Disabled modes can still be activated by name.

`pi --start-mode review` starts a session with a mode already active.

### Status line

While a mode is active, pi's working line shows `<mode> is working...` and the editor border shows `<mode> standby`
when idle — both tinted with the mode colour. The built-in `default` mode changes nothing at all: no instructions,
no tool changes, no model change, no working-line change.

## Mode fields

| Field | Values |
| --- | --- |
| `enabled` | in the `ctrl+tab` rotation |
| `color` | theme token (`accent`, `warning`, `success`, `error`) or hex (`#ff9f43`) |
| `description` | free text, shown only in the panel |
| `instructions` | extra system-prompt section while the mode is active |
| `tools` | `"default"`, `"plan"` (read-only), `"build"` (write set + extras) or an explicit list |
| `model` | `provider/model-id` or unset = session model |
| `subagentModel` | `provider/model-id` or unset = subagent call's own model |

`subagentModel` patches `model` into every `subagent`/`subagent` chain task that does not pin its own model.

## Storage

```jsonc
// ~/.pi/agent/modes.json        (global)
// <cwd>/.pi/modes.json          (project, same names override global)
{
  "review": {
    "enabled": true,
    "color": "#ff9f43",
    "instructions": "Review only. Do not edit files. Report findings with file:line.",
    "tools": "plan",
    "model": "openai-codex/gpt-6.1-sol",
    "subagentModel": "openai-codex/gpt-6.1-luna"
  }
}
```

The reserved name `default` is never stored. Seeded modes are created by the panel or by editing these files; run
`/reload` after manual edits.

## Prompt-cache behaviour

Mode instructions are injected as a **structured system-prompt section** in `before_agent_start`
(`systemPromptOptions.sections.mode`). This is the cache-friendliest option pi offers:

- A system-prompt section stays byte-identical for every turn while the mode is active, so the cached prefix stays
  warm after the first request; pi can also communicate section changes to the provider as a transcript delta instead
  of rewriting the leading system prompt.
- Injecting the same text as a per-turn user message would keep the prefix warm but re-send (and re-bill) the tokens
  every turn and pollute the conversation with synthetic user turns.
- Replacing the whole system prompt (`forceSystemPrompt`) or rewriting the system message with `context_with_system`
  invalidates the cached prefix on every change.

Switching modes mid-session is the only cache cost: the changed section invalidates the prefix once, then stabilises.

## Development

```bash
bun test        # unit tests
bun run check   # typecheck + lint + tests
```

Load the source directly without installing:

```bash
pi --extension packages/add/pi-add-mode/src/index.ts
```
