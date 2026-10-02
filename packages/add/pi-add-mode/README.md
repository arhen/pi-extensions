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
| `alt+m` | Cycle forward over **enabled** modes (default first) |
| `ctrl+tab` / `ctrl+shift+tab` | Aliases, only where the terminal does not consume them |

Enable ≠ activate: `space` in the panel toggles whether a mode is in the `ctrl+tab` rotation; `enter` (or
`/mode <name>`) activates it. Disabled modes can still be activated by name.

`pi --start-mode review` starts a session with a mode already active.

### Status line

While a mode is active, pi's working line shows `<mode> is working...`, and while idle the editor border shows
`<mode> standby`. The whole editor border box (top and bottom lines, working indicator) is tinted with the mode
colour. The built-in `default` mode changes nothing at all: no instructions, no tool changes, no model change, no
border or working-line change.

While a coloured mode is active, pi's own border cues are replaced by the mode colour: the thinking-level colour and
the bash-mode colour while the input starts with `!`. The tint needs this extension's editor; if another editor
extension owns the editor, only the `<mode> standby` widget line is shown.

### Terminal notes

`alt+m` is the primary shortcut. Ghostty leaves plain `alt` chords free, Herdr reserves only its `ctrl+b` prefix, and pi
uses `alt+b/f/d/enter/up/left/right/backspace` but not `alt+m`. It also works without the Kitty keyboard protocol, so it
survives plain tmux and old terminals.

`ctrl+tab` / `ctrl+shift+tab` are registered as aliases, but most terminals consume them before pi sees them — Ghostty
binds both to tab switching — so they usually do nothing.

## Mode fields

| Field | Values |
| --- | --- |
| `enabled` | in the `ctrl+tab` rotation |
| `color` | theme token (`accent`, `warning`, `success`, `error`) or hex (`#ff9f43`) |
| `description` | free text, shown only in the panel |
| `instructions` | extra system-prompt section while the mode is active |
| `tools` | `"default"`, `"plan"` (read-only), `"build"` (write set + extras) or an explicit list |
| `model` | `provider/model-id` or unset = session model |
| `thinking` | effort while the mode is active: `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`, unset = session level |
| `subagentModel` | `provider/model-id` or unset = subagent call's own model |
| `subagentThinking` | effort patched into subagent tasks that do not pin their own |

Picking a model in the editor always asks for the effort right after; cancelling the effort picker aborts the model
change. The effort list follows the model: `off` only for non-reasoning models, minus levels the model marks
unsupported.

`subagentModel` / `subagentThinking` patch `model` and `thinking` into every `subagent` task that does not pin its
own value.

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
    "thinking": "xhigh",
    "subagentModel": "openai-codex/gpt-6.1-luna",
    "subagentThinking": "low"
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
