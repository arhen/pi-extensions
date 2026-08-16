# @arhen/pi — minimalist pi packages

Minimalist [pi coding agent](https://github.com/earendil-works/pi) extensions that just solve problems. One package, one problem. No config surfaces, minimal context footprint.

## Install

Requires the [pi coding agent](https://github.com/earendil-works/pi) — install it first: `npm install -g @earendil-works/pi-coding-agent`.

```sh
npm install -g @arhen/pi-toolset
```

Then manage the whole family:

```sh
pi-toolset install    # install every @arhen/pi-* package (discovered live from npm)
pi-toolset update     # update all installed ones
pi-toolset remove     # remove all installed ones
pi-toolset list       # list the family
```

The family is discovered from the npm registry at runtime — adding a new package needs no changes here. (Script: `pi-toolset` in this repo.)

## Browse the family

- npm: [search @arhen/pi](https://www.npmjs.com/search?q=%40arhen%2Fpi)
- GitHub: [repos starting with pi](https://github.com/arhen?tab=repositories&q=pi)
