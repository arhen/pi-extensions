# 🧩 @arhen Pi Extensions

[![npm scope](https://img.shields.io/badge/npm-@arhen-blue)](https://www.npmjs.com/org/arhen)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Minimalist [Pi Coding Agent](https://github.com/earendil-works/pi) extensions. One package, one problem. No
config surfaces, minimal context footprint. Independently installable, published separately under the
`@arhen` npm scope.

This is the **single source of truth** — all extensions are maintained here in one monorepo. The old
standalone repos are archived and point here.

## Layout

```
packages/
├── core/        → essential family extensions
│   ├── pi-core-ask/
│   ├── pi-core-goal/
│   ├── pi-core-skill-tool/
│   ├── pi-core-subagent/
│   ├── pi-core-todo/
│   ├── pi-core-tps-stats/
│   └── pi-core-vision/
├── add/         → optional family extensions
│   ├── pi-add-9router/
│   ├── pi-add-code-diagnostic/
│   ├── pi-add-commandcode/
│   ├── pi-add-deliberate/
│   ├── pi-add-mode/
│   ├── pi-add-vantis/
│   ├── pi-add-wafer/
│   └── pi-senja/
└── pi-toolset/  → installer for the whole family
```

## 🚀 Install

The toolset installs the whole family at once — it discovers every published `@arhen/pi-*` package
from the npm registry at runtime (the toolset itself excluded), so new packages need no update here:

```bash
npm i -g @arhen/pi-toolset
pi-toolset install          # whole family: core + add-ons
```

Or install individual extensions permanently:

```bash
pi install npm:@arhen/pi-core-subagent
```

Try one without adding it permanently:

```bash
pi -e npm:@arhen/pi-core-vision
```

> [!IMPORTANT]
> Pi extensions run with your full user permissions. Review an extension before installing it from any
> third party.

## 📦 Core extensions

| Package | Use it for |
| --- | --- |
| [`@arhen/pi-core-ask`](packages/core/pi-core-ask) | Structured up-to-4-question questionnaire tool |
| [`@arhen/pi-core-goal`](packages/core/pi-core-goal) | `/goal` long-running objective: session-log state, token budget, auto-continuation |
| [`@arhen/pi-core-skill-tool`](packages/core/pi-core-skill-tool) | Skills catalog, lazy `skill` tool |
| [`@arhen/pi-core-subagent`](packages/core/pi-core-subagent) | Fast in-process subagents, dependency scheduler |
| [`@arhen/pi-core-todo`](packages/core/pi-core-todo) | Flat/nested todos, direct-child progress, bounded tree UI + blockedBy |
| [`@arhen/pi-core-tps-stats`](packages/core/pi-core-tps-stats) | Live tokens-per-second stats |
| [`@arhen/pi-core-vision`](packages/core/pi-core-vision) | Vision fallback for text-only models |

## 🧩 Add-on extensions

| Package | Use it for |
| --- | --- |
| [`@arhen/pi-add-9router`](packages/add/pi-add-9router) | 9router provider registration + model discovery |
| [`@arhen/pi-add-code-diagnostic`](packages/add/pi-add-code-diagnostic) | Repo-scoped typecheck/lint diagnostics |
| [`@arhen/pi-add-commandcode`](packages/add/pi-add-commandcode) | Command Code Provider API: 58 models, dual-endpoint routing, ZDR |
| [`@arhen/pi-add-deliberate`](packages/add/pi-add-deliberate) | Read-only `/advise` second opinions and research-first `/plan`, saved to a path |
| [`@arhen/pi-add-mode`](packages/add/pi-add-mode) | Named modes: instructions + tools + model + effort + subagent model, `/mode` and `alt+m` |
| [`@arhen/pi-add-vantis`](packages/add/pi-add-vantis) | Vantis integration |
| [`@arhen/pi-add-wafer`](packages/add/pi-add-wafer) | Wafer integration |
| [`@arhen/pi-senja`](packages/add/pi-senja) | Gruvbox Material Senja theme, Haiku-style header/footer, state-tinted tool panels |

## 🔧 Manage the set

The [toolset](packages/pi-toolset) manages the family. It reads the package list from npm at
runtime — there is no static list to keep in sync, and no per-package `add` subcommand: install
an extra alone with `pi install npm:@arhen/<pkg>`.

```bash
pi-toolset install   # install the whole family (core + add-ons)
pi-toolset update    # update the installed ones
pi-toolset remove    # remove the installed ones
pi-toolset list      # list the family (toolset itself excluded)
```

## 🛠 Development

npm owns installs and the only lockfile (`package-lock.json`); Bun is the test runner.

```bash
npm install                 # hoist all workspaces
npm run check               # typecheck + biome + tests, every package
npm run format              # biome format + safe fixes
```

Every package exposes the same scripts: `typecheck`, `lint`, `test`, `check`. TypeScript settings
come from `tsconfig.base.json`, lint/format from the root `biome.json`. Shared test fakes for the pi
extension API live in `test-support/fake-pi.ts`. Tests run offline; network checks are opt-in
(`npm run test:live --workspace @arhen/pi-add-commandcode`).

Release = check, bump, publish, commit + tag, push, then `pi update` (`scripts/release.sh`):

```bash
npm run release -- pi-core-subagent              # patch
npm run release -- --minor pi-add-mode pi-senja  # several at once
npm run release -- --dry-run pi-core-goal        # check + npm publish --dry-run only
```

Packages version independently. `pi-toolset` discovers the family from npm at runtime, so it is
released only when its own script changes.

To release a new extension: add the package under `packages/core/` or `packages/add/` and list it in the
layout tree and the relevant table above.

## License

MIT. Each package carries its own `LICENSE` and may include fork attribution.