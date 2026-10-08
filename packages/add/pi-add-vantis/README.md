# @arhen/pi-add-vantis

[![npm version](https://img.shields.io/npm/v/@arhen%2Fpi-add-vantis?color=cb3837&logo=npm)](https://www.npmjs.com/package/@arhen/pi-add-vantis)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Install

Requires the [pi coding agent](https://github.com/earendil-works/pi) — install it first: `npm install -g @earendil-works/pi-coding-agent`.

```sh
pi install npm:@arhen/pi-add-vantis
```

Vantis Cards provider for pi. Live model catalog, Zero Data Retention toggle, balance check.

- Login: `/login` → "Vantis Cards" → API key (or `VANTIS_CARD_API_KEY` / `VANTIS_CARD_KEY`)
- Commands: `/vantis` status · `/vantis zdr [on|off]` · `/vantis refresh` · `/vantis models` · `/vantis balance` · `/vantis hide` (clears the models widget)
- Shortcut: `ctrl+shift+z` toggles ZDR while a vantis model is active

## License

MIT.
