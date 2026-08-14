# pi-skill-tool

Pi extension that implements **opencode2-style skills**: the skill catalog is stripped from the system prompt and exposed through a single lazy `skill` tool.

## Why

Pi injects the full `<available_skills>` catalog (name + description for every skill) into the system prompt — **~7.2K tokens every session, whether you use skills or not**. opencode2 instead packs the catalog into one tool's description and loads skill bodies only when the agent calls the tool.

This extension does the same for pi:

| | Built-in | With pi-skill-tool |
| --- | --- | --- |
| Catalog in system prompt | ✅ ~7.2K tokens always | ❌ stripped |
| Skill bodies | lazy (read on demand) | lazy (tool call) |
| Agent auto-invokes skills | ✅ | ✅ (same — no user input) |
| Catalog size | 28.9K chars | 11.7K chars (truncated to 100 chars/skill) |

Measured fresh-session context (deepseek tokenizer): **26,480 → 22,021 tokens** (-4.5K).

## Install

```bash
pi install npm:@arhen/pi-skill-tool
```

## How it works

1. `before_agent_start` → removes `<available_skills>...</available_skills>` from the system prompt
2. Registers one `skill` tool; its description carries a compact catalog (name + truncated description)
3. Agent matches a task → calls `skill("name")` → gets the full SKILL.md content → follows instructions

Discoveries mirror pi's locations: `~/.pi/agent/skills`, `~/.agents/skills`, npm package `skills/` dirs. Symlinks are deduped via realpath.

## Tradeoffs

- **Truncated descriptions** (100 chars) mean the agent matches on keywords, not full text — the skill body is still complete when loaded
- Skills are still usable via pi's built-in `/skill:name` commands (those don't depend on the system-prompt catalog)
- If you want a skill always visible in the prompt, use pi's `disable-model-invocation: false` default for it — this extension only strips what pi would inject

## License

MIT
