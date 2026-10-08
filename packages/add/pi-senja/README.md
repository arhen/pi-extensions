# @arhen/pi-senja

Senja theme and Haiku's tidier header and footer for [Pi](https://pi.dev).

Forked from [pi-haiku](https://github.com/nnocte/pi-haiku) **0.2.0** by **nocte**, under MIT. The header/footer layout and behavior are preserved; branding, palette, and Pi 1.0 compatibility/safety fixes are the changes. Palette from [Gruvbox Material](https://github.com/sainnhe/gruvbox-material) by **sainnhe**, also MIT.

## What's in it

- **Gruvbox Material dark/medium/material** — exact colors captured from Neovim, matching the Ghostty Senja theme. Background `#282828`, foreground `#d4be98`, orange accent `#e78a4e`. All 56 Pi roles and HTML export backgrounds use palette variables.
- **A header** with shortcuts grouped by control, models, view, and input.
- **A footer** with location, Git branch, session name, provider, model, thinking effort (including `max`), context bar, token usage, latest cache-hit rate, cost, OAuth subscription marker, and extension statuses.
- **State-tinted tool panels** — running tools use amber `#4f422e`, successful tools the warm grey `#32302f`, failed tools maroon `#4c3432`. Your own messages sit one step brighter at `#45403d`, so a user turn, a finished tool block and the `#282828` page all read apart.
- **Quiet tool text** — tool titles and output both use the foreground beige (`fg0`) rather than loud accents, keeping panels calm against their tint.
- **Editor-style code colors** — pink keywords, olive strings, aqua function names, amber types, warm beige identifiers and punctuation, readable muted comments. Applies to code in tool calls/results and Markdown code blocks through Pi's syntax roles.
- **A live timer** while Pi works, plus elapsed-time completion message and notification. Preserves the active mode label and colour from `@arhen/pi-add-mode` (`review is working... 8s`).
- **A fresh start** — clear the visible screen on initial terminal startup without clearing scrollback.

Enabled by default in terminal UI mode. Print, JSON, SDK, and RPC modes do not install terminal components, switch themes, clear the screen, or start UI timers. `/senja` in RPC mode reports that terminal UI is required.

## Install

```bash
pi install npm:@arhen/pi-senja
```

Disable/remove `pi-haiku` or other header/footer replacements to avoid competing UI ownership.

## Toggle

Type `/senja` to turn the header and footer on or off. The theme stays selected. Terminal session startup selects `senja`; selecting another theme afterward still works.

## Development

From the monorepo root, with development dependencies available:

```bash
bun test packages/add/pi-senja/test
bunx tsc -p packages/add/pi-senja/tsconfig.json --noEmit
npm pack --dry-run --workspace @arhen/pi-senja
```

Tests use fake UI/session/timer handles, real Pi width utilities, and the current host theme loader when available. They do not open terminals or write user settings. Set `SENJA_PI_HOST` to an installed Pi coding-agent package directory to validate its theme schema and loader (for example, a Pi 1.0 installation).

## License

MIT. Original **2026 nocte** and Gruvbox Material **2020 sainnhe** notices retained in [LICENSE](LICENSE).
