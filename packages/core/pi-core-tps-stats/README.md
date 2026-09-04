# @arhen/pi-core-tps-stats

[![npm version](https://img.shields.io/npm/v/@arhen%2Fpi-core-tps-stats?color=cb3837&logo=npm)](https://www.npmjs.com/package/@arhen/pi-core-tps-stats)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Install

Requires the [pi coding agent](https://github.com/earendil-works/pi) — install it first: `npm install -g @earendil-works/pi-coding-agent`.

```sh
pi install npm:@arhen/pi-core-tps-stats
```

Live token-per-second stats for active model. Status bar shows median effective t/s + median TTFT; `/tps-stats` shows full stats (samples, avg/median/min/max, TTFT). Stats reset on model change.

**One rate, deliberately.** Effective t/s is all output tokens (thinking + text + tool-call arguments) divided by assistant-response time from turn start to message end. Queue, prefill, and TTFT are included; tool execution is excluded. It reads lower than provider marketing numbers because it is rate you actually wait for.

There is no separate "streaming t/s", because SSE arrival times measure the gateway's flush schedule rather than the model. Measured against `vantis/deepseek-v4-flash-0731-fast` (median inter-chunk gap: 0.01ms — chunks land in instant batches separated by long pauses):

| prompt | turn | window-based | this extension |
|---|---|---|---|
| `Say OK.` | 1.40s | 263 t/s | 41 t/s |
| `List 3 fruits.` | 8.81s | 801 t/s | 14 t/s |
| 900-word essay | 18.49s | 89 t/s | 55 t/s |

The window-based column swings 9x on one model within a minute. Versions before v1.3.0 shipped that math and reported four-digit rates no local model can reach.

TTFT stays a direct observation — first streamed token minus turn start. On reasoning models that first token is usually thinking, not visible text.

```sh
npm test --workspace @arhen/pi-core-tps-stats
```

## License

MIT.
