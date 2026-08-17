# @arhen/pi-core-subagent

[![npm version](https://img.shields.io/npm/v/%40arhen%2Fpi-core-subagent?color=cb3837&logo=npm)](https://www.npmjs.com/package/@arhen/pi-core-subagent)
[![CI](https://img.shields.io/github/actions/workflow/status/arhen/pi-core-subagent/ci.yml?branch=main&logo=github&label=CI)](https://github.com/arhen/pi-core-subagent/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![pi extension](https://img.shields.io/badge/pi-extension-7c3aed)](https://github.com/earendil-works/pi)

## Install

Requires the [pi coding agent](https://github.com/earendil-works/pi) — install it first: `npm install -g @earendil-works/pi-coding-agent`.

```sh
pi install npm:@arhen/pi-core-subagent
# or locally: pi install /path/to/pi-subagents
```

Minimalist pi extension: **fast in-process subagents** with single / parallel / graph modes, background runs, cancellation, intercom (child↔leader) and an agent↔agent mailbox.

Built for one job: delegate work to isolated subagents **without bloating the parent context**.

One rule underneath everything else:

> **A task is a graph, not a checklist.** Nodes are workers, edges are data dependencies. The edge both gates the dependent *and* hands it the upstream output — so "the coordinator forgot to pass X" stops being a failure mode. Where there are no edges, there is no graph: flat fan-out stays flat.

That is [Graph Protocol](#graph-protocol), applied to the runtime rather than to the prompt.

```mermaid
flowchart LR
    subgraph w1["wave 1 — runs in parallel"]
        api["api<br/><i>api-mapper</i>"]
        db["db<br/><i>db-mapper</i>"]
    end
    gate{{"gate"}}
    subgraph w2["wave 2"]
        doc["doc<br/><i>writer</i>"]
    end
    api -- "route map" --> gate
    db -- "schema map" --> gate
    gate -- "both outputs<br/>prepended to the prompt" --> doc
```

![Subagents widget](docs/subagents-widget.png)

*The `subagent` tool call plus the live above-editor widget: per-agent activity, tool counts, turns, token counters and timers.*

## Design principles

- **The delegation is the graph.** `needs` declares edges; the scheduler runs each wave of ready tasks in parallel and gates the rest. One code path for single, parallel, chain and graph — `chain` is just `needs: [previous]`. ([why](#why-waves-instead-of-more-agents))
- **Edges carry data, not just order.** An upstream task's output is prepended to its dependents' prompts automatically. The coordinator cannot forget to pass it, because it never passes it.
- **A bad graph fails before it spawns.** Unknown ids, self-edges and cycles are rejected at call time — never halfway through a run with three children already burning tokens.
- **Proof is an exit code, never a self-report.** Tasks are asked for a runnable `Verify:` command; the leader checks `git diff --stat`. Agents auditing their own work score ~0. ([why](#why-9-is-a-verification-command-not-a-self-report))
- **No ceremony without edges.** Six independent reviewers stay six independent reviewers — no waves, no gates, no graph vocabulary imposed on flat work.
- **No agent files, no discovery.** The leader defines every subagent inline per call — name, system prompt, toolset. Nothing is read from or written to disk.
- **Two toolsets only.** Read-only (`read, grep, find, ls` — default) or write (`read, grep, find, ls, bash, edit, write` — `write: true`). No per-agent tool config surface.
- **In-process** — children are `AgentSession`s in the same runtime. No process spawn, no context bleed.
- **Zero parent-context injection.** No catalog, no context hook. 6 slim tools total.
- **Throttled updates** — widget/stream updates coalesce to ~6/s; no per-event deep clones.
- **No silent hangs** — watchdog aborts children that produce no events for 3 minutes.
- **No default runtime cap** — tasks run until done, stalled (watchdog), or aborted by the user. `maxRuntimeMs` is opt-in (default 0 = unlimited).

## How it runs

Children are not subprocesses. They are separate `AgentSession`s inside the same pi process — which is why spawning is instant, and why a child's transcript never lands in your context:

```mermaid
flowchart TB
    subgraph proc["one OS process — no spawn, no IPC"]
        direction TB
        L["<b>leader</b><br/>your session, your context"]
        subgraph kids["isolated child sessions"]
            direction LR
            A["api-mapper"]
            B["db-mapper"]
        end
    end
    L -- "task text in" --> A
    L -- "task text in" --> B
    A -. "final answer only" .-> L
    B -. "final answer only" .-> L
```

The dotted arrows are the whole point: a child may burn 200k tokens reading files, and the leader receives only its final answer.

## Usage — the leader invents the agents

Define agents inline per call — never creates or reads agent files. Model resolution: explicit `provider/model-id` (or bare id) via the pi model registry → agent-file `model` → the parent's current model → settings default.

```json
{
  "agent": "api-reviewer",
  "prompt": "You are a strict API reviewer. Check auth, rate limiting, and error handling. Cite file:line.",
  "task": "Review src/api/upload.ts"
}
```

Parallel — mixed toolsets, siblings can talk via mailbox:

```json
{
  "allowIntercom": true,
  "tasks": [
    { "agent": "researcher", "prompt": "You find facts. Cite paths.", "task": "Map the auth flow", "write": false },
    { "agent": "implementer", "prompt": "You make minimal changes.", "task": "Implement POST /api/upload", "write": true }
  ]
}
```

Chain — `{previous}` is replaced with the prior agent's output:

```json
{
  "chain": [
    { "agent": "planner", "prompt": "You write a step list.", "task": "Plan the change", "write": false },
    { "agent": "doer", "prompt": "You follow the plan exactly.", "task": "Execute: {previous}", "write": true }
  ]
}
```

## Graph mode — `needs`

`parallel` runs everything at once; `chain` runs everything one at a time. Most real work is neither. Give a task an `id` and list the ids it `needs`:

```json
{
  "tasks": [
    { "id": "api", "agent": "api-mapper", "task": "Map every route in src/api/" },
    { "id": "db",  "agent": "db-mapper",  "task": "Map the schema in src/db/" },
    { "id": "doc", "agent": "writer", "needs": ["api", "db"], "write": true,
      "task": "Write ARCHITECTURE.md from the maps above. Verify: test -s ARCHITECTURE.md" }
  ]
}
```

The call line renders the graph in §2 notation as the model types it:

```
subagent graph 3
  6 at a time
  wave1[api ∥ db] → gate → wave2[doc]
  api api-mapper Map every route in src/api/
  db  db-mapper Map the schema in src/db/
  doc writer ✎ ← api, db Write ARCHITECTURE.md from the maps above. Verify: test -s ARCHI…
```

`✎` marks a write-toolset task; `←` lists its edges. With no `needs` anywhere the wave line is omitted entirely.

### What one edge does

An edge is not just ordering. It is a delivery:

```mermaid
sequenceDiagram
    participant S as scheduler
    participant A as api
    participant D as db
    participant W as doc

    Note over S,D: wave 1 — both start together
    S->>A: "Map every route in src/api/"
    S->>D: "Map the schema in src/db/"
    A-->>S: route map
    Note right of W: doc is queued,<br/>waiting at the gate
    D-->>S: schema map
    Note over S: gate opens: every need settled
    S->>W: ## Output of api<br/>&lt;route map&gt;<br/><br/>## Output of db<br/>&lt;schema map&gt;<br/>---<br/>"Write ARCHITECTURE.md…"
```

The leader never copies those outputs into the prompt — so it cannot forget to.

### One scheduler, four shapes

Single, parallel, chain and graph are not four code paths. They are four shapes of the same wave loop:

```mermaid
flowchart LR
    subgraph one["single"]
        direction TB
        s1(("a"))
    end
    subgraph par["parallel — no needs"]
        direction TB
        p1(("a")) ~~~ p2(("b")) ~~~ p3(("c"))
    end
    subgraph ch["chain — needs: [previous]"]
        direction TB
        c1(("a")) --> c2(("b")) --> c3(("c"))
    end
    subgraph gr["graph — needs"]
        direction TB
        g1(("a")) --> g2(("b"))
        g1 --> g3(("c"))
        g2 --> g4(("d"))
        g3 --> g4
    end
```

### The loop

```mermaid
flowchart TD
    start(["subagent call"]) --> validate{"graph valid?<br/><small>unknown id · self-edge · cycle</small>"}
    validate -- no --> reject["reject the call<br/><b>zero children spawned</b>"]
    validate -- yes --> loop{"tasks left?"}
    loop -- no --> done(["run finished"])
    loop -- yes --> ready["frontier =<br/>tasks whose needs are all settled"]
    ready --> spawn["run that wave in parallel<br/><small>throttled by concurrency</small>"]
    spawn --> collect["record each output<br/>mark tasks settled"]
    collect --> loop
```

Two consequences worth stating plainly:

- **A bad graph costs nothing.** Validation happens before the first spawn, never halfway through with three children already burning tokens.
- **A broken upstream stops its branch.** If a need fails or is aborted, its dependents are marked aborted rather than run against a prompt with a hole in it:

```mermaid
flowchart LR
    api["api ✓"] --> doc
    db["db ✗ failed"] --> doc["doc ⏹ skipped<br/><small>never spawned</small>"]
```

And the rule that keeps this from becoming ceremony: **zero `needs` anywhere = plain parallel.** No waves, no gates, no graph vocabulary imposed on flat work.

Background (default) + intercom — the run returns a runId immediately; you stay steerable while it works:

```json
{
  "agent": "auditor",
  "prompt": "You audit dependencies.",
  "task": "Audit package.json for outdated deps",
  "allowIntercom": true
}
```

**Steering a running child:** while a background run is active the leader stays responsive, and you can push a message into a live child's session mid-run with `steer_subagent` — e.g. `steer_subagent({ runId, taskId, message: "Ignore tests/, only audit runtime deps" })`. The message queues as a steer if the child is mid-turn and lands at its next model boundary. Omit `taskId` to steer every still-running task in the run. Combined with `notifyPerTask`, this makes a background run feel like a live team you can redirect, not a fire-and-forget blob.

## Tools

| Tool | Purpose |
|---|---|
| `subagent` | single / `tasks` (parallel or graph via `needs`) / `chain` (`{previous}`); background is the default (`background:false` for inline result in this turn); `allowIntercom:true` enables child talk tools; `notifyPerTask` (default true) wakes you as each task completes (background runs only) |
| `subagent_status` | live per-task snapshot (non-blocking), including each child's session file path |
| `subagent_result` | full output of a run or one task |
| `await_subagent` | block until a run finishes (optional `timeoutMs`) |
| `reply_subagent` | answer a child's `ask_parent` question |
| `steer_subagent` | inject a steering message into a running child's session (queues as steer if mid-turn; lands at its next model boundary) |
| `subagent_cancel` | abort a running/queued run |

### Per-task fields

`agent` (name you invent — required), `task` (required), `prompt` (system prompt, optional — minimal default used), `write` (toolset, default read-only), plus optional `model` (`provider/model-id`), `thinking` (validated enum: `off|minimal|low|medium|high|xhigh|max`), `tools` (explicit allowlist), `cwd`, `maxRuntimeMs`, `id`, `needs` (dependency edges — see [Graph mode](#graph-mode--needs)). Top-level only: `background`, `notifyPerTask`, `allowIntercom`, `concurrency`.

### Child talk tools (when `allowIntercom: true`)

| Tool | Meaning |
|---|---|
| `ask_parent` | blocking question to the leader; parent answers via `reply_subagent` |
| `notify_parent` | one-way message to the leader |
| `send_agent_message` | message to a sibling subagent's mailbox (`to` = its task id, or `"leader"`) |
| `poll_agent_messages` | drain this subagent's mailbox |

> **Intercom anti-deadlock:** children are told to never block indefinitely on intercom replies — `ask_parent` keeps the stall watchdog fed while awaiting a parent reply (background runs), and sibling polls are capped (~5 tries) with a proceed-with-best-judgment fallback. Gated siblings (later waves) may not be running yet — waiting on them is the top stall cause, so children are instructed not to.

## Commands

- `/subagents` — list runs; `/subagents peek` (or `ctrl+shift+a`) — browsable pane
- `/subagents auto-bg on|off` — toggle background-by-default for subagent calls (persists to `~/.pi/agent/subagents-config.json`; default on). `off` makes calls block until the run finishes, result inline in the same turn. Bare `/subagents auto-bg` shows the current state.
- `/subagents auto-limit on|off` — toggle leader-imposed `maxRuntimeMs` caps (persists to the same config; default on). `off` strips ALL task timeouts: tasks run unlimited until done, stalled, or aborted — only for runs where a hard bound is genuinely required is a cap kept (none, when off). Bare `/subagents auto-limit` shows the current state.

## Peek — `/subagents peek` or `ctrl+shift+a`

Read-only pane over the session's subagents:

- `shift+↑`/`shift+↓` (or `j`/`k`) — move between agents; bare arrows work too where the terminal doesn't reserve them
- `enter` — live tail of that child's session file (`esc` goes back)
- `x` then `y` — abort ONE subagent (only mutation; `n`/any other key cancels)
- `esc` — close

## Watching a child from outside

A child has no terminal of its own — but it does write a real transcript file, and that file is the seam every external viewer can use:

```mermaid
flowchart LR
    child["child session<br/><small>no TTY</small>"] -- writes --> file[("session.jsonl")]
    file -- "peek · enter" --> pane["in-pi tail"]
    file -- "tail -f" --> term["any terminal pane<br/><small>herdr · tmux · zellij</small>"]
```

`subagent_status` returns that path for every running child:

```sh
tail -f /path/from/subagent_status.jsonl
```

In a terminal multiplexer, that is a pane per agent — e.g. with [Herdr](https://herdr.dev):

```sh
herdr pane split --current --direction right
herdr pane run w1:p2 "tail -f /path/from/subagent_status.jsonl"
```

The extension has no multiplexer integration and does not want one: it exposes the path, your agent already knows how to drive its own terminal. For an in-pi view of the same stream, use [`/subagents peek`](#peek--subagents-peek-or-ctrlshifta).

## Context budget

- Parent tools: 6 schemas with short descriptions. **No catalog, no context hook** — nothing injected per request.
- Background completion: 3-line notice. Full text only via `subagent_result`.
- Children: isolated sessions; talk tools injected only when `allowIntercom`; each child's prompt states its own task id and its siblings' so mailbox addressing works. Model resolution: explicit `provider/model-id` or bare id via the pi model registry → the parent's current model → settings default. Thinking levels validated against the resolved model's `thinkingLevelMap`.

## What this is built on

### Graph Protocol
<a id="graph-protocol"></a>

`needs` is an implementation of [Graph Protocol](https://gist.github.com/r17x/90eb2f7be93932b5693753aedb09c01a) — a delegation discipline that treats a task as a graph (`Delegation<A, E, R>`) rather than a checklist. Its ten sections map onto this extension as follows:

| § | Protocol | Here |
|---|---|---|
| §1 | nodes, domains, edges | one `agent` owns one task; `needs` are the edges |
| §2 | happy path as execution graph, waves + gates | wave scheduler: `ready = tasks whose needs are settled` |
| §3 | one worker or many | `single` vs `tasks` |
| §4 | break points: wrong context, **missing input**, misinterpretation | missing input is structurally impossible — the edge carries the output |
| §5 | R: subgraph, method, **verification command**, WHY | prompt guidelines require a runnable `Verify:` line per task |
| §6 | structured at the boundary | in: upstream outputs prepended as named blocks. out: prose (see below) |
| §7 | observe without changing the graph | the widget and `/subagents peek` are read-only |
| §8 | worker attention acquired and released | spawn → terminal status; aborted upstream releases dependents immediately |
| §9 | prove it: delegated vs implemented | **deliberately not self-reported** — see below |
| §10 | prompt = subgraph, return = implemented graph | prompt yes; return kept as prose |

### Why §9 is a verification command, not a self-report

The protocol asks the coordinator to compare the delegated subgraph against the graph the worker says it implemented. We implement the comparison against **the filesystem and the exit code**, not against the worker's account of itself, because self-reports carry close to zero signal about exactly the failure §9 exists to catch:

- Asked to audit its own work against 34 real violations, an agent reported **0** — at 90–100 confidence. A *fresh* instance of the same model shown the same output caught 7 (p = 0.0156). A deterministic checker caught all 34. ([Armalo Labs, 2026](https://www.armalo.ai/labs/research/2026-06-11-zero-bit-self-audit))
- Across 9,876 τ2-bench and 1,879 AppWorld trajectories, "false success" reached **75.8%** of self-assessing coding-agent failures; adding an LLM judge scored **0.54–0.65 AUROC** (0.5 = coin flip). ([arXiv:2606.09863](https://doi.org/10.48550/arxiv.2606.09863))
- LLM judges reading agent traces can be flipped by rewriting the trace — the exact surface a self-reported graph exposes. ([arXiv:2601.14691](https://arxiv.org/html/2601.14691))

The shape of the problem:

```mermaid
flowchart TD
    W["worker finishes"] --> Q{"who says it's correct?"}
    Q -- "the worker itself" --> S["self-report<br/><b>0 of 34 caught</b><br/><small>at 90–100 confidence</small>"]
    Q -- "another model reading the trace" --> J["LLM judge<br/><b>0.54–0.65 AUROC</b><br/><small>0.5 = coin flip</small>"]
    Q -- "the machine" --> D["exit code + git diff<br/><b>34 of 34 caught</b>"]
```

So §9 in practice is two things you already have:

```sh
# in the task text — the worker must prove it, not claim it
Verify: npx tsc --noEmit && bun test

# in the leader, after the run — ground truth, not narrative
git diff --stat
```

If files outside a worker's subgraph were touched, the diff says so. A structured return schema would only add a second, less trustworthy witness.

### Why waves instead of "more agents"

Flat fan-out is not free — orchestration cost is `critical path + α × cross-agent communication`, and ignoring the second term is what makes added agents *lose* to a single one:

- Dependency-graph partitioning vs flat file-parallel spawning across 28 real repos: **+14.0% pass rate, 2.10× wall-clock, −35% API cost**, with the largest gains on the most dependency-dense projects. Flat parallel inflated cost 60% for a 1.56× speedup; an agent-team baseline was fastest but scored *below sequential* on code quality. ([arXiv:2606.00953](https://arxiv.org/html/2606.00953v1))
- Dynamic task graphs across 300 trials: 47.5% of baseline token cost, 79.7% accuracy vs 57.6% for a static graph — and, notably, **static tied dynamic when the structure was genuinely known up front**, which is the case `needs` targets. The "frontier" (ready set) in this scheduler is theirs. ([arXiv:2605.06320](https://arxiv.org/html/2605.06320))

The corollary is in the design principles: when there are no edges, don't draw a graph. Six independent reviewers stay six independent reviewers.

## Development

```sh
bun install        # dev deps (typecheck/test only; runtime uses pi's bundled SDK)
npx tsc --noEmit
bun test           # pure-logic tests (wave scheduling, edge payload, mailbox, failure classification, watchdog)
```

Runtime state: runs persist to `<parent-session>.subagents.json` sidecar; restored (non-terminal → aborted) on session start.

## License

MIT.
