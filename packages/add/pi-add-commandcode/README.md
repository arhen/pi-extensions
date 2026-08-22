# @arhen/pi-add-commandcode

[![npm version](https://img.shields.io/npm/v/@arhen%2Fpi-add-commandcode?color=cb3837&logo=npm)](https://www.npmjs.com/package/@arhen/pi-add-commandcode)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Install

Requires the [pi coding agent](https://github.com/earendil-works/pi) — install it first: `npm install -g @earendil-works/pi-coding-agent`.

```sh
pi install npm:@arhen/pi-add-commandcode
```

[Command Code Provider API](https://commandcode.ai/docs/provider) for pi — 58 models on one key, live catalog, dual-endpoint routing, Zero Data Retention toggle.

- Login: `/login` → "Command Code" → API key (or `COMMANDCODE_API_KEY`)
- `/commandcode` — status: key, model count, ZDR state
- `/commandcode zdr [on|off]` — Zero Data Retention (persisted across sessions)

## Endpoint routing

The API is two endpoints on one base, and using the wrong one is a hard `400`:

| Models | Endpoint | pi API |
| --- | --- | --- |
| `claude-*` (7) | `/provider/v1/messages` | `anthropic-messages` |
| everything else (51) | `/provider/v1/chat/completions` | `openai-completions` |

Routing is per model, so `/model` just works — pick any id and the right shape is sent.

Models are fetched in the extension factory, which pi awaits before startup finishes, so the catalog is ready for interactive startup and `/model`. Fetching in `session_start` instead leaves the provider empty on first paint.

## Model metadata

`GET /provider/v1/models` returns only `id`, `name`, and `context_length` — no pricing, no capability flags. So metadata comes from two sources:

- **Claude ids** reuse pi's built-in `ANTHROPIC_MODELS` entry. Rates are identical to the Command Code docs, and it carries `forceAdaptiveThinking` and `supportsTemperature`, which Opus 4.7+/Sonnet 4.6 need to think correctly.
- **Everything else** reads the `CATALOG` table in `src/index.ts`, transcribed from [pricing & limits](https://commandcode.ai/docs/resources/pricing-limits).

```sh
npx tsx src/index.test.ts   # runs the real factory against a stub API
```

The test asserts every live model resolves to exactly one source, that Claude ids route to Messages with a `/v1`-less baseUrl, and that an offline refresh preserves the catalog rather than emptying it. Run it after Command Code adds models: a model in neither source still registers, but bills as free and claims `reasoning: true`, so the test fails rather than letting that ship.

## Zero Data Retention

`/commandcode zdr on` sends `x-cmd-zdr: 1` on every request, so it routes only through ZDR-capable upstreams. Per the docs there is **no silent fallback**: a model with no ZDR upstream fails with `422 cmd_zdr_no_providers` instead of quietly using a non-ZDR route. ZDR may also change which upstream serves you, so cost can differ.

## Notes

- Reasoning effort accepts `low|medium|high|xhigh|max`. There is no `none`, so thinking-off is marked unsupported and pi omits the field.
- Token usage arrives at the end of every stream with no opt-in, so pi's built-in cost footer works as-is.
- Claude ids register on any plan but return `403 MODEL_NOT_IN_PLAN` unless your plan covers them.
- Long-context pricing tiers (8 models bill ~2× past a threshold) are not modelled — `CATALOG` holds the standard tier, so cost reads low on very large contexts.

## License

MIT.
