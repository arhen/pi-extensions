# pi-skill-tool

[![npm version](https://img.shields.io/npm/v/@arhen/pi-skill-tool)](https://www.npmjs.com/package/@arhen/pi-skill-tool)
[![npm downloads](https://img.shields.io/npm/dm/@arhen/pi-skill-tool)](https://www.npmjs.com/package/@arhen/pi-skill-tool)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/arhen/pi-skill-tool)](https://github.com/arhen/pi-skill-tool)

Pi extension that implements **opencode2-style skills**: the skill catalog is stripped from the system prompt and exposed through a single lazy `skill` tool.

## Why

Pi injects the full `<available_skills>` catalog (name + description for every skill) into the system prompt — **~7.2K tokens every session, whether you use skills or not**. opencode2 instead packs the catalog into one tool's description and loads skill bodies only when the agent calls the tool.

This extension does the same for pi.

## How it works

1. `before_agent_start` → removes `<available_skills>...</available_skills>` from the system prompt
2. Registers one `skill` tool; its description carries a compact catalog (name + truncated description, 100 chars/skill)
3. Agent matches a task → calls `skill("name")` → gets the full SKILL.md content → follows instructions

Discoveries mirror pi's locations: `~/.pi/agent/skills`, `~/.agents/skills`, npm package `skills/` dirs. Symlinks are deduped via realpath.

## Full comparison matrix

Measured on a fresh session (`deepseek-v4-flash`, no user message beyond "hi").

```
┌───────────────────────┬─────────┬──────────────────────────────────┬───────────────────┐
│ Config                │ Context │ Agent invokes skills?            │ User /skill:name? │
├───────────────────────┼─────────┼──────────────────────────────────┼───────────────────┤
│ Baseline (nothing)    │ 26,480  │ ✅ (reads SKILL.md from catalog) │ ✅                │
├───────────────────────┼─────────┼──────────────────────────────────┼───────────────────┤
│ Ext ON (strip + tool) │ 22,021  │ ✅ (calls skill tool)            │ ✅                │
├───────────────────────┼─────────┼──────────────────────────────────┼───────────────────┤
│ Ext OFF + flag ON     │ 18,660  │ ❌ dead — invisible              │ ✅ only           │
└───────────────────────┴─────────┴──────────────────────────────────┴───────────────────┘
```

### Row by row

**Baseline (nothing)** — stock pi, no extension, no flags.

- Context: **26,480 tokens** every session.
- The full catalog (all 69 skills, name + description + file path ≈ 28.9K chars) is embedded in the system prompt.
- The agent sees every skill listed and can `read` any SKILL.md it wants — skills are fully agent-invocable.
- Cost: the catalog is paid upfront whether or not any skill is ever used.

**Ext ON (strip + tool)** — this extension installed, default mode.

- Context: **22,021 tokens** (-4,459 vs baseline).
- The catalog is removed from the system prompt and instead lives inside the description of one `skill` tool (truncated to 100 chars/skill ≈ 11.7K chars).
- The agent still auto-invokes skills — it matches a task against the tool's catalog, calls `skill("name")`, and receives the full SKILL.md content. No user input.
- `/skill:name` still works (pi's command system is independent of the prompt catalog).

**Ext OFF + flag ON** — extension removed, `disable-model-invocation: true` added to every SKILL.md frontmatter.

- Context: **18,660 tokens** — the cheapest, but at a hard cost.
- The flag hides skills from the system prompt entirely, so the agent **cannot see or load them**.
- Only the user can trigger a skill by typing `/skill:name`.
- Verified: asked about a private skill, the agent could not load it and improvised by reading unrelated source files instead.

### The tradeoff in one line

The 3.4K tokens between Ext ON and Ext OFF+flag is the price of **agent-side skill invocation**. Ext OFF+flag saves the most but makes skills user-only — the agent's ability to use skills is gone. Ext ON keeps skills fully agent-invocable for a fraction of the baseline cost.

## Our case — measured on this machine

Reference environment (the numbers above come from it):

- **Model**: `deepseek/deepseek-v4-flash` (deepseek tokenizer)
- **Skills loaded**: 69 (23 lark-*, 8 caveman-family, 6 npm-shipped: pi-lens ×4, pi-subagents, mcp-scripting, plus design/security/vercel/next misc)
- **Tool count**: 25 baseline → 26 with the extension (the extra one is `skill`)

Context composition at baseline (26,480 total):

| Component | Tokens | Share |
| --- | --- | --- |
| 25 tool definitions (schemas + descriptions) | ~16K | 60% |
| System prompt text (instructions, guidelines) | ~10.5K | 40% |
| — of which: skill catalog (`<available_skills>`) | ~7.2K | 27% |

Context excluding skills ≈ **19.3K** — that's pi's floor with this tool set (dominated by pi-subagents ~9.5K + pi-lens ~4.5K tool schemas).

What the extension changes:

| | Baseline | Ext ON | Δ |
| --- | --- | --- | --- |
| Skill catalog in system prompt | 28.9K chars | stripped (0) | -28.9K |
| Catalog in `skill` tool description | — | 11.7K chars | +11.7K |
| Net catalog cost | 7.2K tok | 2.9K tok | **-4.3K** |
| Total fresh context | 26,480 | 22,021 | **-4,459** |

## Pros

- **Saves ~4.5K tokens/session** — 17% of fresh context, every session, no behavior change
- **Agent keeps full skill autonomy** — same invocation flow as baseline, no user input required
- **Lazy by design** — skill bodies load only when the tool is called, exactly like opencode2
- **Zero config** — discovers the same skill locations pi uses, dedupes symlinks
- **Reversible** — uninstall to go back to baseline; no skill files are modified
- **Kill switch** — `PI_SKILL_TOOL=0` disables the tool (strip-only, ~18K) for emergency savings

## Cons

- **Truncated descriptions** (100 chars) — the agent matches on keywords rather than full text. Skill bodies are complete when loaded; only the catalog summary is shortened
- **Catalog still costs ~2.9K** — the tool description must carry skill names for the agent to discover them. Removing it entirely (Ext OFF+flag) is cheaper but kills agent invocation

## Install

```bash
pi install npm:@arhen/pi-skill-tool
```

## License

MIT
