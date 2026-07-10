# /agents — Feature Plan

A fourth button in the agents flow sidebar (`index.html`, next to `/loop`,
`/prompts` and `/adversarial review`) that opens an **in-app modal** with a
library of reusable agents (e.g. "frontend reviewer", "pest test reviewer").
Each agent bundles one or more markdown files of instructions. Clicking an
agent **inserts its content into the currently selected terminal pane** —
e.g. while `claude` is running in the focused pane, one click pastes the full
agent brief as a single block, ready for the user to review and press Enter.

The modal supports the full lifecycle: **create, edit, delete and search**
agents.

Decisions already made:

- **Modal, not window.** `/loop`, `/prompts` and `/adversarial review` open
  dedicated `WebviewWindow`s, but `/agents` must know *which terminal pane is
  focused in the main window* at click time. A separate window loses that
  context (and OS focus). The right precedent is the command palette
  (`src/modules/workspaces/command-palette/`): an overlay inside the main
  webview with search + keyboard navigation.
- **Insert content, not file paths.** An agent's files live in the app store,
  not on the project's disk, so the insert writes the composed markdown into
  the PTY. Wrapping the write in **bracketed paste** (`ESC[200~ … ESC[201~`)
  makes multi-line content arrive as one pasted block in `claude`/`codex`
  instead of submitting line by line.
- **No trailing Enter.** Same convention as `terminal-drop.ts`: the user
  reviews the inserted text and presses Enter themselves.
- **Persistence: JSON store**, mirroring `loop-profiles-store.ts`
  (`@tauri-apps/plugin-store`, debounced full-snapshot saves, `schemaVersion`
  guard). SQLite (`db.rs`) was considered and rejected for v1 — agents are a
  small, manually-edited collection with no cross-session query needs.

---

## 1. User experience

### 1.1 Entry point

```html
<button type="button" class="agents-flow-btn" id="open-agents">/agents</button>
```

Clicking it (or pressing a future shortcut) opens the modal. **Before** the
modal grabs focus, the handler snapshots the insert target:

1. `router.getActive()` → the `TerminalManager` of the active project.
2. `manager.focusedPaneId` → the focused pane; fall back to the first pane of
   the active project when none is focused.
3. Resolve the pane's `ptyId`. If there is no live pane at all, the modal
   still opens for CRUD but the insert action is disabled with a hint
   ("open a terminal first").

### 1.2 Modal — list mode (default)

Two-column layout inside a centered dialog (~760×480):

- **Header:** search input (autofocused) + "new agent" button + target badge
  showing where the insert will go (e.g. `→ pane 2 · claude`).
- **Left column:** agent list. Each row: name, description, file count.
  Hovering/arrow keys move the selection.
- **Right column:** preview of the selected agent — file titles as chips and
  the composed markdown (read-only), so the user sees exactly what will be
  pasted. Row actions: **insert**, **edit**, **delete**.
- **Activation:** click on a row or Enter inserts into the captured pane,
  closes the modal, refocuses the terminal and shows a toast
  (`inserted "frontend reviewer" into pane 2`).
- **Keyboard:** `↑/↓` navigate, `Enter` insert, `Cmd+N` new agent, `Esc`
  close. Search filters as you type (multi-token AND substring match over
  name + description + file titles + file content, same strategy as the
  command palette — no fuzzy library).

### 1.3 Modal — editor mode (create / edit)

Same dialog swaps to a form:

- **name** (required, unique-ish — duplicates allowed but warned).
- **description** (one line, shown in the list).
- **files:** ordered list of `{ title, content }`. One file minimum; "add
  file" appends another title + textarea block; each file has a remove
  button (disabled when only one file remains). This is how a single agent
  can be "one file or multiple files".
- **save / cancel.** Save runs validation (non-empty name, at least one file
  with non-empty content), persists, returns to list mode with the new/edited
  agent selected.

### 1.4 Delete

Trash icon on the selected row → `confirmModal({ danger: true })` (existing
`shared/ui/modal.ts`) → remove from state, persist, toast.

---

## 2. Data model

```ts
// src/modules/agents/types.ts
export interface AgentFile {
  id: string; // crypto.randomUUID()
  title: string; // e.g. "review-checklist.md"
  content: string; // markdown body
}

export interface AgentDef {
  id: string;
  name: string; // "frontend reviewer"
  description: string; // "React/CSS review checklist"
  files: AgentFile[]; // 1..n
  createdAt: number;
  updatedAt: number;
}

export interface AgentsState {
  agents: AgentDef[];
  schemaVersion: 1;
}
```

### 2.1 Composed insert text

```ts
// Pure function, unit-tested.
export function composeAgentText(agent: AgentDef): string {
  if (agent.files.length === 1) return agent.files[0].content.trim();
  return agent.files
    .map((f) => `<!-- ${f.title} -->\n${f.content.trim()}`)
    .join("\n\n");
}

export function bracketedPaste(text: string): string {
  return `[200~${text}[201~`;
}
```

Insert = `ptyWrite(ptyId, bracketedPaste(composeAgentText(agent)))` — the
existing `pty-client.ts` API, no Rust changes required.

---

## 3. Module layout

```
src/modules/agents/
  types.ts              # AgentDef / AgentFile / AgentsState
  compose.ts            # composeAgentText + bracketedPaste (pure)
  compose.test.ts
  agents-controller.ts  # in-memory state + CRUD + subscribe, wraps the store
  agents-controller.test.ts
  agents-modal.ts       # overlay UI: list mode + editor mode + keyboard
  agents-modal-list.ts  # render helpers (rows, preview), like command-palette-list
  agents.css            # imported from styles.css or the module entry

src/shared/persistence/
  agents-store.ts       # clone of loop-profiles-store.ts for agents.json
  agents-store.test.ts
```

Wiring in `src/app/app-controller.ts` (same place the other three buttons are
mounted):

```ts
mountAgentsButton({
  router: this.router, // PaneLookup for the insert target
  // controller is created lazily on first open; state loads from agents.json
});
```

### 3.1 Controller contract

```ts
export interface AgentsController {
  getState(): AgentsState;
  subscribe(fn: (s: AgentsState) => void): () => void;
  create(input: { name: string; description: string; files: AgentFileInput[] }): AgentDef;
  update(id: string, patch: { name?; description?; files? }): void;
  remove(id: string): void;
}
```

Every mutation updates `updatedAt`, emits to subscribers and calls
`queueSaveAgents(state)` (debounced 250 ms, full snapshot — identical
semantics to `queueSaveLoopProfiles`).

### 3.2 Insert target resolution

```ts
export interface InsertTarget {
  ptyId: string;
  paneLabel: string; // for the badge + toast
}

export function resolveInsertTarget(router: TerminalRouter): InsertTarget | null {
  const manager = router.getActive();
  if (!manager) return null;
  const paneId = manager.focusedPaneId ?? manager.ids()[0] ?? null;
  // map paneId -> pane -> ptyId via manager.get(paneId)
}
```

Captured once at modal-open time and kept for the lifetime of that modal
instance. If the pane died while the modal was open, `ptyWrite` rejects — we
catch, toast an error and keep the modal open.

---

## 4. Persistence

`agents-store.ts` is a line-for-line adaptation of `loop-profiles-store.ts`:

- Store file: `agents.json`, single `state` key, full snapshots.
- `schemaVersion !== 1` → silent fallback to empty state (never break boot).
- `queueSaveAgents` debounce 250 ms; `flushSaveAgents` snapshots `pending`
  before any `await` (same concurrency note as workspaces/loop-profiles).
- Flush on `beforeunload` alongside the other stores in `lifecycle.ts`.

---

## 5. Implementation phases

| Phase | Scope | Done when |
| --- | --- | --- |
| **F1** | `types.ts`, `compose.ts` (+tests), `agents-store.ts` (+tests), `agents-controller.ts` (+tests) | `pnpm test` green; CRUD round-trips through `agents.json` |
| **F2** | Modal list mode: open/close, search, keyboard nav, preview, insert via `ptyWrite` + bracketed paste; `/agents` button + wiring in `app-controller.ts` | Click on seeded agent pastes into focused `claude` pane as one block |
| **F3** | Editor mode: create/edit forms, multi-file add/remove, validation; delete with `confirmModal` | Full CRUD from the UI, persisted across restarts |
| **F4** | Polish: empty states, target badge, toasts, `Cmd+N`, duplicate-name warning, style pass to match command palette | UX review |

---

## 6. Testing

- `compose.test.ts` — single file (no header comment), multi-file (titled
  sections), trimming, bracketed-paste wrapping.
- `agents-store.test.ts` — round-trip, schema-version fallback, debounce
  collapse (mirror `loop-profiles-store.test.ts`).
- `agents-controller.test.ts` — create/update/remove, `updatedAt` bump,
  subscriber notifications, snapshot queued per mutation.
- Modal filtering — extract `filterAgents(agents, query)` as a pure function
  and test the multi-token AND semantics.
- Manual: insert into a live `claude` pane (multi-line arrives as one paste,
  no auto-submit); insert with no pane open (disabled + hint); delete
  confirmation.

---

## 7. Out of scope (v1)

- Importing agent files from disk / exporting to `.claude/agents/`.
- Per-project agents (the library is global, like loop profiles).
- Variables/placeholders inside agent content (e.g. `{{branch}}`).
- Sending Enter automatically after insert.
