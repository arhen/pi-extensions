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
├── core/        → essential extensions (installed by the toolset)
│   ├── pi-core-ask/
│   ├── pi-core-skill-tool/
│   ├── pi-core-subagent/
│   ├── pi-core-todo/
│   ├── pi-core-tps-stats/
│   └── pi-core-vision/
├── add/         → optional/extra extensions (opt in)
│   ├── pi-add-9router/
│   ├── pi-add-code-diagnostic/
│   ├── pi-add-commandcode/
│   ├── pi-add-vantis/
│   └── pi-add-wafer/
└── pi-toolset/  → installer: manage the installed set
```

## 🚀 Install

The easiest way to get the whole **core set** at once is the toolset:

```bash
npm i -g @arhen/pi-toolset
pi-toolset install          # installs all @arhen/pi-core-* packages
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
| [`@arhen/pi-core-skill-tool`](packages/core/pi-core-skill-tool) | Skills catalog, lazy `skill` tool |
| [`@arhen/pi-core-subagent`](packages/core/pi-core-subagent) | Fast in-process subagents, dependency scheduler |
| [`@arhen/pi-core-todo`](packages/core/pi-core-todo) | Todo tool with 4-state machine + blockedBy |
| [`@arhen/pi-core-tps-stats`](packages/core/pi-core-tps-stats) | Live tokens-per-second stats |
| [`@arhen/pi-core-vision`](packages/core/pi-core-vision) | Vision fallback for text-only models |

## 🧩 Add-on extensions

| Package | Purpose for |
| --- | --- |
| [`@arhen/pi-add-9router`](packages/add/pi-add-9router) | 9router provider registration + model discovery |
| [`@arhen/pi-add-code-diagnostic`](packages/add/pi-add-code-diagnostic) | Repo-scoped typecheck/lint diagnostics |
| [`@arhen/pi-add-commandcode`](packages/add/pi-add-commandcode) | Command Code Provider API: 58 models, dual-endpoint routing, ZDR |
| [`@arhen/pi-add-vantis`](packages/add/pi-add-vantis) | Vantis integration |
| [`@arhen/pi-add-wafer`](packages/add/pi-add-wafer) | Wafer integration |

## 🔧 Manage the set

The [toolset](packages/pi-toolset) manages the installed extension set.

```bash
pi-toolset install   # install core set
pi-toolset add <pkg> # add an extra extension
pi-toolset update    # update installed
pi-toolset remove    # remove an extension
```

## 🛠 Development

```bash
npm install                 # hoist all workspaces
npm run check               # typecheck every package
```

Bump + publish a package from its workspace dir (published to the `@arhen` scope):

```bash
cd packages/pi-core-subagent && npm version patch && npm publish
```

To release a new extension: add the package under `packages/core/` or `packages/add/` and list it in the
relevant table above.

## License

MIT. Each package carries its own `LICENSE` and may include fork attribution.