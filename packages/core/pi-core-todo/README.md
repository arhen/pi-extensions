# @arhen/pi-core-todo

[![npm version](https://img.shields.io/npm/v/@arhen%2Fpi-core-todo?color=cb3837&logo=npm)](https://www.npmjs.com/package/@arhen/pi-core-todo)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Flat or arbitrarily nested todos for [Pi](https://github.com/earendil-works/pi), with explicit statuses, dependency links, atomic batch mutations, a compact widget, and a scrollable tree browser.

## Install

```sh
pi install npm:@arhen/pi-core-todo
```

Registers `todo` and `/todos`; use only one todo extension at a time.

## Nested todos

Nesting is optional. Existing flat tasks and saved sessions continue to work.

```json
{ "action": "create", "subject": "Build feature" }
{ "action": "create", "subject": "Add validation", "parentId": 1 }
{ "action": "create", "subject": "Check inputs", "parentId": 2 }
```

Tool headings identify those tasks as `#1`, `#1.a`, and `#1.a.a`. Todo rows show clean titles without ID prefixes. Each nesting level uses sibling letters, continuing through `z`, `aa`, `ab`, etc. Deleted siblings reserve their letters so surviving siblings do not get renamed. Reparenting intentionally changes display paths.

Tool arguments still use stable **numeric IDs**. Model-facing results include numeric references for children, while tool headings use hierarchical display paths and todo rows contain no IDs.

- Set `parentId` on create/update to attach a task at any depth.
- Set `parentId: null` to move a task and its subtree to the root.
- Omit `parentId` to leave existing behavior unchanged.
- Missing/deleted parents, self-parenting, and hierarchy cycles are rejected.
- Nesting and `blockedBy` dependencies are separate relationships.

### Status and progress

Statuses stay explicit: `pending ⇄ in_progress → completed`, plus `deleted` tombstones (terminal and immutable). Completing a child does not change its parent's status. A parent cannot be completed while any live descendant is unfinished, and unfinished subtrees cannot be attached under completed parents.

Each parent displays **`[completed direct children / total live direct children]`**. Grandchildren and deeper descendants are not counted in that parent's counter; leaves have no counter.

Deleting a parent, including `update` with `status: "deleted"`, promotes its live direct children to the nearest live ancestor, or the root. It never deletes their subtrees. Existing dependency cleanup still removes links to the deleted task.

## Bounded UI

```text
todo → #7.b.b

● Todos (2/12)
├─ ○ Build nested todos [1/2]
│  ├─ ✓ Parent links
│  └─ ○ Safe reparenting [1/2]
│     ├─ ✓ Validate parents
│     └─ ◐ Reject cycles
└─ +7 hidden · /todos
```

The above-editor widget uses at most **8 total lines or one quarter of the terminal height**, whichever is smaller. Short panes shrink it to a summary/active row; panes below four rows hide it. Active tasks and their ancestor context take priority over unrelated rows. Completed rows hide after the next agent turn without changing progress totals.

Deep indentation compresses with an explicit depth marker; long display paths compress in tool headings. Subjects are sanitized and truncated by visible terminal columns, including ANSI styling, wide characters, and emoji.

Tool calls are single-line previews. Results remain bounded even when expanded: at most 5 collapsed or 8 expanded lines, reduced further for short panes. Mutations show the affected task rather than repeating the whole list. Model-facing `list` output shows up to 100 tasks; `get` provides individual details.

### `/todos` browser

Open the full tree in a bounded overlay: at most 24 lines or 70% of terminal height. All tasks remain reachable by scrolling and folding; no long notification consumes the screen.

| Key | Action |
| --- | --- |
| ↑ / ↓ | Move selection |
| ← | Collapse branch, or select its parent |
| → | Expand branch, or select its first child |
| Enter / Space | Toggle branch |
| PgUp / PgDn | Scroll one page |
| Home / End | First / last visible task |
| Esc / Ctrl+C | Close and return to the editor |

Selection stays visible when the terminal resizes. The browser is read-only and TUI-only: outside a terminal `/todos` notifies instead of opening. The agent manages task state through `todo`.

## Tool contract

Actions: `create`, `update`, `batch`, `list`, `get`, `delete`, `clear`.

Fields: `subject`, `description`, `activeForm`, `status`, `parentId`, `id`, `blockedBy`, `addBlockedBy`, `removeBlockedBy`, `owner`, `metadata`, `includeDeleted`, plus `ops` for `batch`.

Create produces a pending task; update sets its explicit status. `blockedBy` is the create-time seed — on update use `addBlockedBy` / `removeBlockedBy`. Dependency updates are additive, with self-block/cycle rejection. List hides deleted tasks unless `includeDeleted: true` and supports a status filter. Tombstoned tasks reject mutation (`task #N is deleted; tombstones are immutable`). `clear` wipes the list and restarts IDs at 1.

Keep the list live while you work: the same tool adds the new step, splits a step into child subtasks via `parentId`, rewords or re-scopes an item, and cancels dropped work by deleting it. An `update` must change something — a status or another mutable field; an update without one is rejected.

### Batch changes

`batch` applies an ordered `ops` array of `create` / `update` / `delete` in one call, so a whole list, subtree, or round of progress updates is one tool call instead of many.

```json
{
  "action": "batch",
  "ops": [
    { "action": "create", "ref": "parent", "subject": "Build feature" },
    { "action": "create", "subject": "Add validation", "parentId": "parent" },
    { "action": "create", "subject": "Wire UI", "parentId": "parent" },
    { "action": "update", "id": "parent", "status": "in_progress", "activeForm": "building feature" },
    { "action": "delete", "id": 7 }
  ]
}
```

- Each op accepts the same fields and validation as the matching single action; the top level carries only `ops`.
- Ops run in order on the accumulated list. The batch is **atomic**: the first failing op aborts it — nothing is applied and the error names the op, e.g. `batch op 2 (update): #99 not found; no changes applied`.
- A create op may declare `ref` (letter-first alias). Later ops target it in `id`, `parentId`, `blockedBy`, `addBlockedBy`, or `removeBlockedBy`. Refs are unique per batch and only resolve backwards; numeric strings like `"7"` resolve as task ids.
- `delete` accepts only `id`; tombstone immutability, parent completion, dependency cycles, and dedup rules are identical to single actions.
- Results report one line per op (`created #1: Build feature`, `updated #1 (pending → in_progress)`), and the UI preview lists the affected tasks, bounded like `list`.

## Persistence

Per-session state is isolated and saved in `~/.pi/agent/pi-todo-state.json`. Parent links survive restarts; old snapshots without them remain valid. There is no branch-history replay. Sidecar persistence assumes one Pi process per agent directory; concurrent processes can overwrite one another's state.

## Development

```sh
bun test packages/core/pi-core-todo/test
bunx tsc -p packages/core/pi-core-todo/tsconfig.json --noEmit
```

Tests cover reducers, batch atomicity and refs, deep hierarchy operations, deletion, display paths, direct-child counters, narrow/short rendering, keyboard folding/scrolling, resize, and hostile terminal text.

## License

MIT. Forked from `@juicesharp/rpiv-todo`.
