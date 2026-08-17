# @arhen/pi-core-tps-stats

[![npm version](https://img.shields.io/npm/v/@arhen%2Fpi-core-tps-stats?color=cb3837&logo=npm)](https://www.npmjs.com/package/@arhen/pi-core-tps-stats)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Install

Requires the [pi coding agent](https://github.com/earendil-works/pi) — install it first: `npm install -g @earendil-works/pi-coding-agent`.

```sh
pi install npm:@arhen/pi-core-tps-stats
```

Live token-per-second stats for the active model. Status bar shows median generation t/s + median TTFT; `/tps-stats` shows full stats (samples, avg/median/min/max, effective t/s, TTFT). Stats reset on model change.

Two rates, both counting **all** output tokens (thinking + text + tool-call arguments) because that is what `usage.output` reports:

- **Generation t/s** — tokens / the window from the first streamed token to the end of the message. What the model sustains once it starts producing.
- **Effective t/s** — tokens / the whole turn, so queue and prefill latency drag it down. What you actually wait for.

TTFT is time to the *first* streamed token of any kind; on reasoning models that first token is usually thinking, not visible text.

**Buffered providers.** Some gateways don't really stream — they hold the whole completion server-side, then flush every chunk within a millisecond. `vantis/deepseek-v4-flash-0731-fast` does this: 4.7s to first token, then 26 chunks in under 1ms. There is no stream window to divide by, so generation t/s is not reported at all; the status bar switches to `eff` and shows effective t/s, whose window is the full turn and stays honest. A high TTFT next to `eff` means the provider buffered, not that the model was slow to start.

> Numbers before v1.1.0 were inflated — a text-only time window was paired with a token count that still included tool-call arguments, which reported ~766 t/s median (peaks near 4800) where the real rate was ~52. v1.2.0 fixes a second inflation source: buffered providers whose sub-millisecond flush made any window-based rate meaningless (~1500 t/s readings).

```sh
npm test --workspace @arhen/pi-core-tps-stats
```

## License

MIT.
