# pi-9router

Pi Coding Agent extension for [9router](https://9router.example.com) — AI routing proxy.

Registers 9router as a Pi provider with dynamic model discovery. **Provider only, no web tools** — use [pi-web-access](https://github.com/nicobailon/pi-web-access) for web search/fetch.

## Features

- Auto-discovers models and combos from 9router `/v1/models` on startup
- Registers `9router` provider with dynamic base URL + API key
- Cached discovery (fast startup, credential-fingerprinted)
- models.dev metadata enrichment (context window, max tokens, input modalities)
- Reasoning support (`thinkingLevelMap` → `reasoning_effort`)
- Commands: `/9router-status`, `/9router-models`, `/9router-config`, `/9router-reasoning`, `/9router-reload`

## Install

```bash
pi install npm:@arhen/pi-9router
```

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `NINE_ROUTER_BASE_URL` | `http://localhost:20128` | 9router endpoint |
| `NINE_ROUTER_API_KEY` | — | API key if 9router requires auth |
| `NINE_ROUTER_ENABLE_REASONING` | — | `1`/`true` to expose thinking levels |

Config persists to `~/.pi/agent/9router-config.json` (shared across Pi instances).

## Commands

| Command | Purpose |
| --- | --- |
| `/9router-config` | Configure base URL, API key, reasoning |
| `/9router-status` | Connection status, model counts |
| `/9router-models` | Browse models/combos and switch |
| `/9router-reasoning` | Toggle thinking levels |
| `/9router-reload` | Re-discover models |

## Why not pi-9router-ext?

[pi-9router-ext](https://github.com/irfansofyana/pi-9router-ext) bundles the same provider **plus** web tools (`ninerouter_web_search`, `ninerouter_web_fetch`) and web-route discovery (~1.2K tokens extra in context). This package is the provider flow only — same config file format, same env vars, so they're drop-in interchangeable.

## License

MIT
