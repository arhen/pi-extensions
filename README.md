# @arhen/pi — minimalist pi packages

Minimalist [pi coding agent](https://github.com/earendil-works/pi) extensions that just solve problems. Each package is small, focused, and adds minimal context overhead.

| Package | v | What it does |
|---|---|---|
| [@arhen/pi-subagent](https://github.com/arhen/pi-subagent) | 0.2.11 | subagent orchestration — parallel/chain/background/intercom/mailbox |
| [@arhen/pi-todo](https://github.com/arhen/pi-todo) | 1.0.0 | todo tool + tree widget, 4-state, blockedBy |
| [@arhen/pi-ask](https://github.com/arhen/pi-ask) | 1.0.0 | structured questionnaire |
| [@arhen/pi-vision](https://github.com/arhen/pi-vision) | 1.1.0 | vision fallback |
| [@arhen/pi-9router](https://github.com/arhen/pi-9router) | 0.1.0 | 9router provider |
| [@arhen/pi-skill-tool](https://github.com/arhen/pi-skill-tool) | 0.1.1 | skills |
| [@arhen/pi-tps-stats](https://github.com/arhen/pi-tps-stats) | 1.0.0 | tokens/sec stats |
| [@arhen/pi-vantis](https://github.com/arhen/pi-vantis) | 1.0.0 | Vantis provider |
| [@arhen/pi-wafer](https://github.com/arhen/pi-wafer) | 1.0.0 | Wafer provider |

## Install

```sh
pi install npm:@arhen/pi-subagent
pi install npm:@arhen/pi-todo
pi install npm:@arhen/pi-ask
pi install npm:@arhen/pi-vision
pi install npm:@arhen/pi-9router
pi install npm:@arhen/pi-skill-tool
pi install npm:@arhen/pi-tps-stats
pi install npm:@arhen/pi-vantis
pi install npm:@arhen/pi-wafer
```

## Philosophy

- One package, one problem
- No config surfaces — fixed, sensible behavior
- Minimal context footprint (few tools, no context hooks)
- Inline-first, stateless where possible
