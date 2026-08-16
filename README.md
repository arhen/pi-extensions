# @arhen/pi-core-todo

[![npm version](https://img.shields.io/npm/v/@arhen%2Fpi-todo?color=cb3837&logo=npm)](https://www.npmjs.com/package/@arhen/pi-core-todo)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![pi extension](https://img.shields.io/badge/pi-extension-7c3aed)](https://github.com/earendil-works/pi)

Minimalist pi todo extension: `todo` tool with a 4-state machine and `blockedBy` dependencies, `/todos` command, persistent tree widget. Fork of `@juicesharp/rpiv-todo`, cut to the core — no i18n, no branch replay, no config, no lazy-loading machinery.

## Install

```sh
pi install npm:@arhen/pi-core-todo
```

> Registers the `todo` tool — conflicts with other todo extensions (`@juicesharp/rpiv-todo`). Run one at a time.

## What's kept

- `todo` tool: create / update / list / get / delete / clear
- 4-state machine: `pending → in_progress → completed`, `deleted` tombstone (legal-transition validation)
- `blockedBy` dependencies: create with initial set, `addBlockedBy` / `removeBlockedBy` additive updates, self-block and cycle rejection
- `/todos` command: grouped status listing
- Tree widget above the editor: `● Todos (n/m)` heading, `├─/└─` rows, status glyphs, `#id` + `⛓` deps when present, completed rows hide one turn after completion
- Per-session state isolation (detached/child sessions never clobber each other)
- Sidecar persistence (`~/.pi/agent/pi-todo-state.json`, debounced) — survives restarts

## What's cut (vs rpiv-todo)

- i18n/locales — inline English
- Branch/fork replay — replaced by sidecar persistence (no replay of history across forked sessions)
- Config dialog, collapse shortcut, guidance validation — fixed behavior
- Lazy overlay loader + stale-module detection — direct import, register-once widget

## Tool contract

Same LLM-facing schema as rpiv-todo: `action` (required) + per-action fields (`subject`, `status`, `id`, `blockedBy`, `addBlockedBy`, `removeBlockedBy`, `activeForm`, `description`, `owner`, `metadata`, `includeDeleted`). Prompt guidelines preserved verbatim (never batch completions, one task in_progress at a time, keep it in_progress on failure).

## Development

```sh
bun install
npx tsc --noEmit
bun test   # pure-logic: reducer, transitions, cycles, sanitize
```

## License

MIT.
