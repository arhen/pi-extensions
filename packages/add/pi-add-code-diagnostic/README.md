# @arhen/pi-add-code-diagnostic

[![npm version](https://img.shields.io/npm/v/@arhen%2Fpi-add-code-diagnostic?color=cb3837&logo=npm)](https://www.npmjs.com/package/@arhen/pi-add-code-diagnostic)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Install

Requires the [pi coding agent](https://github.com/earendil-works/pi) — install it first: `npm install -g @earendil-works/pi-coding-agent`.

```sh
pi install npm:@arhen/pi-add-code-diagnostic
```

LSP-equivalent diagnostics for coding agents — no language servers, no JSON-RPC, no server lifecycle. One configured command per repo, run by the agent loop itself.

## How it works

- **Tier 1 — per-file lint on write/edit.** If the repo config has `fileCheck` (e.g. `eslint ${file}`), it runs silently in the background after each agent write/edit. Never blocks.
- **Tier 2 — global check at agent settle.** Runs the repo's `check` command (e.g. `tsc --noEmit`) once per session, then after any agent edit. Errors surface as a `followUp` message; `triggerTurn` re-engages the agent to fix them, so the agent keeps working until the tree is clean.
- **Discovery, one message per session.** Repo has no config yet → the agent is asked to inspect the repo, propose a `check`/`fileCheck`, self-test it, confirm with you, and write the config. `off` or `enabled: false` = silent forever.
- **Fail-open everywhere.** A broken command never blocks the agent. 3 crashing runs auto-disable the config. Aborted agent runs skip the check.
- **Loop guard.** The same error report with no edits since → shown only, no re-trigger.

## Config

Per repo root at `~/.pi/repos/<root-sanitized>.json`:

```json
{ "check": "tsc --noEmit", "fileCheck": "eslint ${file}", "enabled": true }
```

Commands are split on whitespace (no shell pipes/`&&`) and run with a 120s timeout from the repo root.

## Commands

- `/diagnostic` — status: root, check cmd, fileCheck, enabled, testedAt, lastExit
- `/diagnostic run` — run the global check now
- `/diagnostic clear` — delete the repo config; discovery re-runs

## License

MIT.
