# context mode — analysis, architecture and implementation plan

Offload tool-call output out of the agent's context window into a local store,
and return a queryable handle instead of raw bytes. Inspired by
[context-mode.com](https://context-mode.com/) (npm `context-mode`, Elastic
License 2.0), reimplemented natively rather than vendored — see §12.

---

## 0. Status

Working end to end for **Claude Code**, verified against a real session: the
agent ran `git log --oneline` on a 400-commit repository, received a 253-byte
pointer instead of 29 KB, then located a single commit with `polakapi ctx search`
without re-running git.

- Engine: store (SQLite + FTS5), routing, chunking, summarising, storage tiers
  with promotion, `polakapi ctx` and `polakapi ctx-mcp`.
- Wiring: switching Claude Code on in Settings installs a `PreToolUse` hook that
  rewrites large-output shell commands through `polakapi ctx exec`, and a
  `SessionStart` hook that tells the model how to search what was stored. Both
  act only inside polakapi terminals, and are removed when switched off.
- `PostToolUse` is not used: for built-in tools it cannot replace output that
  already reached the model.
- The rewrite omits `permissionDecision`. Verified empirically that the rewrite
  still applies, so the user's normal approval flow is kept rather than skipped.

Not wired: Codex (hook output format unverified), OpenCode and Cursor (no hooks
polakapi can use), and the "Add .polakapi/ to .gitignore" toggle.

## 1. What the concept actually is

The framing "dump tool output to a file" undersells it. The mechanism has three
distinct return paths, chosen by size and by whether the data needs to stay
verbatim:

| Path | When | What enters context |
| --- | --- | --- |
| **Bypass** | output < ~1 KB | the raw output, unchanged |
| **Summarize** | aggregate-friendly data (logs, CSV, test output, browser snapshots) | a computed summary (~150–1200 B) |
| **Index + search** | text that must stay exact (docs, API refs, code, tool schemas) | a *pointer*, then exact chunks on demand |

The upstream benchmark measures 376 KB raw → 16.5 KB in context across 21
scenarios. The two subtotals differ sharply and the difference is the design
lesson: the summarize path reaches 98%, the index+search path only 82% — it
deliberately gives up savings to return `useEffect` blocks verbatim, because a
summary saying "3 sections about cleanup" is useless for writing code.

The pointer is **not a file path**. Upstream returns a source identifier plus an
instruction:

```
Indexed 42 sections (12 with code) from: execute:shell
Use ctx_search(queries: ["..."]) to query this content.
Use source: "execute:shell" to scope results.
```

This matters: the model never learns a filesystem path, so it cannot `cat` the
file back into context and undo the saving. The handle is a **query scope**.
We keep that property.

The second half of the idea is the input side — "think in code". Instead of 47
`Read()` calls dragging 700 KB into context, the agent writes one script, it
runs sandboxed, and only its stdout enters context. Same principle applied
before the data ever exists.

**Explicit non-goal, inherited:** do not instruct the model to be terse. Upstream
is right to separate *where data goes* from *how the model writes*; aggressive
brevity prompts measurably degrade coding and reasoning.

---

## 2. Why polakapi is unusually well placed

The npm package fights for control from outside. polakapi **spawns the CLI**, so
it already owns the seams that implementation has to beg for:

- the process environment and argv (`pty.rs:121-228` `spawn_session`)
- a single-binary helper convention already proven by `polakapi capture`
  (`main.rs:25-27`)
- a hook installer that merges into each CLI's config idempotently
  (`db/hooks.rs`)
- SQLite with `rusqlite` bundled, already open as `State<Mutex<Db>>`
- atomic project-file writers with path-component guards
  (`loop_prompts::write_atomic`, `is_safe_run_id`)
- a live per-pane context panel (`src/modules/agent-context/`) that can show the
  savings as they happen

---

## 3. Prerequisite: the capture path, and what actually gates it

The hook→capture pipeline is **live** as of 0.12.0. `pty.rs:164-169` calls
`configure_capture_environment` with `Db::resolve_path(&app).ok().as_deref()`,
and `pty.rs:329-351` injects `POLAKAPI_PTY_ID` unconditionally,
`POLAKAPI_DB_PATH` whenever the DB path resolves, and `POLAKAPI_CLI` for
allowlisted AI-CLI basenames, removing only the vestigial `POLAKAPI_HELPER`.
Shells keep the pty id but have an inherited `POLAKAPI_CLI` / `POLAKAPI_DB_PATH`
stripped, so a shell spawned from an agent pane cannot masquerade as the CLI
(`pty.rs:558-573`).

An earlier revision of this document claimed the pipeline was dormant. That was
read from a pre-merge tree: commit `640ed16` had indeed replaced the injector
with a stripper, and #31 restored it as `configure_capture_environment`. Working
Claude notifications in 0.12.0 are the end-to-end proof, since
`notifications::capture_hook` bails without `POLAKAPI_PTY_ID`
(`notifications.rs:62`).

What remains is not a repair but a gate: **hook installation is opt-in**. The
`sessions` table only fills for users who pressed "Enable agent hooks"
(`settings.ts:85-93`), and only for `claude` and `codex` — the sole CLIs
`prompt_install_hooks` accepts (`hooks.rs:27-32`).

Consequences for this plan:

- `ctx-mcp` can rely on `POLAKAPI_PTY_ID` and `POLAKAPI_DB_PATH` reaching the CLI
  process, so per-session scoping needs no new transport.
- The agent-context panel resolves `cli_session_id` only when hooks are
  installed; otherwise it falls back to the newest transcript for the pane's cwd,
  which is ambiguous with two panes of the same CLI in one repository.
- Context mode must therefore either require hooks on the CLIs that support them,
  or carry its own session correlation for the ones that do not.

---

## 4. Per-CLI capability matrix — the honest version

Interception quality varies enormously. The design must degrade per CLI rather
than promise one behaviour for four targets.

| CLI | Hooks in polakapi today | `PreToolUse` | Can rewrite tool input | Enforcement available |
| --- | --- | --- | --- | --- |
| **claude** | 8 events, `~/.claude/settings.json` | not installed yet, supported | yes (`updatedInput`) — *verify* | **hard**: deny + rewrite |
| **codex** | 4 events, `~/.codex/hooks.json` | not installed yet | no — deny-only (openai/codex#18491) | **medium**: deny + reason |
| **opencode** | none | n/a | n/a | **soft**: MCP + instructions |
| **cursor-agent** | none | undocumented for the CLI binary | unknown | **soft**: MCP + instructions |

Two consequences:

1. **Delivery must not depend on hooks.** The agent has to be able to query what
   was offloaded, and hooks cannot provide that. Two routes reach all four CLIs:
   MCP, which all four speak, and a plain subcommand, which any CLI with a shell
   tool can call (§5.0). Hooks sit on top as an *enforcement* layer where the CLI
   allows it — never as the delivery mechanism.
2. Soft enforcement is genuinely weaker. Upstream reports roughly 60% compliance
   on instruction-only platforms versus 98% with hooks. The settings UI must say
   which mode a given CLI is running in, rather than implying parity.

Also note an existing id mismatch to fix: the registry uses profile id `cursor`
for binary `cursor-agent` (`cli-registry.ts:17-40`), while
`prompt_install_hooks` accepts only `"claude"`/`"codex"` (`hooks.rs:27-32`).

---

## 5. Architecture

```
src-tauri/src/ctx/
  mod.rs          # module map
  router.rs       # routing policy: bypass | summarize | index  (pure, tested)
  chunk.rs        # heading/code-aware chunking                 (pure, tested)
  summarize.rs    # what to say about aggregate data            (pure, tested)
  store.rs        # SQLite + FTS5: sources, chunks, savings
  paths.rs        # temp vs project store, promotion, self-ignoring dir, sweep
  session.rs      # one session's store, including promotion
  offload.rs      # route -> summarise or index -> what the model sees
  config.rs       # reads the Context Mode settings the UI writes
  mcp.rs          # stdio MCP server: `polakapi ctx-mcp`
  cli.rs          # shell surface:    `polakapi ctx …`

src/modules/settings/
  context-mode-preferences.ts   # store, defaults, validation  (pure, tested)
  context-mode-section.ts       # the settings section
  controls.ts                   # row/toggle/select/number factories
```

### 5.0 Two surfaces, one store

MCP is **not** required. What the design actually needs is that the agent can
*query* what was offloaded; a pointer it cannot resolve is worse than useless.
Two surfaces provide that, and both talk to the same store:

| Surface | Reach | Cost |
| --- | --- | --- |
| `polakapi ctx …` subcommand | every CLI that can run a shell command — all four | no registration; the syntax has to be taught in the routing instructions, and arguments go through shell quoting |
| `polakapi ctx-mcp` MCP server | every CLI that speaks MCP | schema discovery and typed arguments, but it must be registered per CLI |

The subcommand is the floor: it works everywhere, needs no config, and lets the
user inspect the store by hand. MCP is the better experience where registering
it is easy. Shipping both costs one extra module.

### 5.1 The MCP server (`polakapi ctx-mcp`)

Same single-binary trick as `capture`: `main.rs` dispatches `ctx-mcp` before
Tauri boots. Registered into each CLI's MCP config at hook-install time, with
`POLAKAPI_PTY_ID` / `POLAKAPI_DB_PATH` passed through so the server scopes its
store to the pane that spawned it.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `ctx_exec` | run a shell command or script; raw output never enters context |
| `ctx_search` | BM25 query over offloaded sources, optionally scoped by `source` |
| `ctx_read` | fetch one chunk verbatim by `source` + section |
| `ctx_list` | what this session has offloaded, with sizes and savings |

`ctx_exec` is the "think in code" primitive: it takes either a command or an
inline script plus a runtime, runs it in a subprocess inheriting the pane's cwd,
and routes its stdout through the router in §6.

### 5.2 Enforcement layer (hooks)

Extend `desired_hooks` in `db/hooks.rs` with `PreToolUse`:

- **claude** — matcher on `Bash|WebFetch|Read|Glob|Grep`. The helper decides:
  allow small/cheap calls untouched; for calls predicted to be large, either
  rewrite into `ctx_exec` via `updatedInput`, or deny with a reason naming the
  replacement call.
- **codex** — same matcher, deny-only. A deny carrying a clear reason is still
  effective: the model retries with the suggested `ctx_*` tool.

Prediction is necessarily heuristic before execution (`PreToolUse` sees the
command, not the output). Start conservative: only intercept commands with a
known-large signature (`gh ... --json`, `cat` of a file above the threshold,
`find`/`ls -R` over large trees, `curl`, log reads), and let everything else
through. Over-blocking is worse than under-saving.

`capture.rs` gains a `PreToolUse` branch; note it currently *discards*
`PostToolUse` payloads entirely (`capture.rs:70-75`), so the tool name and input
are parsed by nothing today.

### 5.3 Instruction injection

The routing rules must survive compaction. `SessionStart` re-injects them; for
Claude and Codex this rides the existing hook. Upstream re-nudges every N
intercepted calls, which is worth copying.

For opencode and cursor-agent, with no hooks, the rules have to live in a file
the CLI reads. **This writes into the user's project**, so it must be opt-in per
project in settings, never automatic.

---

## 6. The offload contract

### 6.1 Routing policy (`router.rs`, pure and unit-tested)

```
if bytes < BYPASS_MAX (default 1 KiB)        -> Bypass
else if kind.is_exact_text()                 -> Index      (docs, code, schemas)
else if bytes > EXTERNALIZE_MIN (100 KiB)    -> Index      (never summarize huge)
else                                         -> Summarize  (logs, csv, metrics)
```

`BYPASS_MAX` earns its place: upstream measures only **13% savings on a 0.4 KB
payload** — below ~1 KB the machinery costs more than it saves.

### 6.2 What returns to context

Summarize path — the summary only, no handle. The raw artifact stays on disk for
the user, not for the model.

Index path — the pointer, deliberately path-free:

```
Indexed 42 sections (12 with code) from: exec:gh-issue-list
Use ctx_search(queries: [...]) to query this content.
Use source: "exec:gh-issue-list" to scope results.
```

Source ids are `kind:slug`, slug derived from the command and deduped per
session.

### 6.3 Store schema

```sql
CREATE TABLE ctx_source (
  id           INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL,     -- pty id
  source       TEXT NOT NULL,     -- "exec:gh-issue-list"
  kind         TEXT NOT NULL,     -- shell | fetch | file | mcp
  raw_bytes    INTEGER NOT NULL,
  context_bytes INTEGER NOT NULL, -- what we actually returned
  artifact     TEXT,              -- path to raw bytes on disk
  created_at   INTEGER NOT NULL,
  UNIQUE(session_id, source)
);
CREATE TABLE ctx_chunk (
  id        INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES ctx_source(id) ON DELETE CASCADE,
  ordinal   INTEGER NOT NULL,
  heading   TEXT,
  has_code  INTEGER NOT NULL DEFAULT 0,
  body      TEXT NOT NULL
);
CREATE VIRTUAL TABLE ctx_fts USING fts5(
  body, heading, content='ctx_chunk', content_rowid='id', tokenize='porter'
);
```

`raw_bytes` and `context_bytes` are what the panel turns into a savings figure —
measured, not claimed.

**Verified:** the bundled `libsqlite3-sys` in `rusqlite 0.32` ships FTS5 with
the `porter` tokenizer. The chunk bodies live *only* in the FTS5 table, keyed by
the chunk rowid, so the text is never stored twice.

---

## 7. Storage: tmp by default, promoted into the project

Per your requirement, two tiers with an explicit promotion step.

**Tier 1 — ephemeral (default).**
`<temp>/polakapi/ctx/<pty-id>/` — artifacts plus a per-session SQLite file.
Deleted when the pane closes and on app start for dead sessions. Precedent:
`loop_cli/process.rs:96` already writes to temp.

**Tier 2 — durable, inside the project.**
`<project>/.polakapi/ctx/<session>/`, following the `.loop/` and `.adversarial/`
precedent (`loop_prompts/runs.rs:46`, `adv_review.rs:68`) and reusing
`write_atomic` with the same path-component guards.

Promotion triggers, all configurable:

- session exceeds **N offloaded sources** (default 20) or **M MB raw** (default
  25), or
- session older than **H hours** (default 2), or
- the user pins it from the context panel (a "keep" action on the row).

Promotion copies the artifacts and re-points the store; it never moves data out
of the project once promoted.

**Git ignoring.** The app has never touched a user's `.gitignore` — grepping the
sources returns zero hits, and `docs/adversarial-review-plan.md:316` records
that as a deliberate non-decision. Rather than break that, write the directory
so that it ignores itself:

```
<project>/.polakapi/.gitignore   ->   *
```

A `.gitignore` containing `*` excludes the whole subtree including itself, with
**zero edits to the user's own file** — no merge conflicts, no formatting loss,
nothing to undo if they uninstall. A settings toggle can additionally offer
appending `.polakapi/` to the root `.gitignore` for people who prefer it
explicit, off by default.

---

## 8. Settings

The settings window has **no section registry** — `settings.ts:15-16` hardcodes
one innerHTML with a single static "App" sidebar item, and every control is
appended into one `.settings-group`. Adding a second section therefore means
building the nav/panel switching first; that is real work, not a row.

Plan: introduce a minimal section list (reuse the `BOTTOM_TABS` pattern from
`bottom-panel/types.ts` — a `const` array plus a type guard), keep "App" as the
first entry, add "Context Mode":

| Control | Default |
| --- | --- |
| Enable context mode | off |
| Per-CLI enable + mode badge (hard / medium / soft) | per §4 |
| Bypass threshold (KB) | 1 |
| Externalize threshold (KB) | 100 |
| Storage: ephemeral / promote automatically / always in project | promote |
| Promotion thresholds (sources, MB, hours) | 20 / 25 / 2 |
| Also add `.polakapi/` to the project `.gitignore` | off |
| Intercepted tools per CLI (checkbox list) | Bash, WebFetch |

Persistence follows `preferences.ts`: a sibling store module writing
`context-mode.json` via `tauri-plugin-store`, with a `normalize*` validator and
an `emit` so live panes pick changes up without restart.

---

## 9. Surfacing the savings

The agent-context panel already renders per-pane context occupancy. Add one line
per row, fed by `ctx_source` sums:

```
ctx   ████░░░░░░  47k/200k (24%)
saved 312 KB → 4.1 KB  (18 sources)
```

This is the honest feedback loop: if a routing rule is not paying for itself the
user sees it immediately, rather than trusting a marketing number.

---

## 10. Implementation phases

| Phase | Scope | Done when |
| --- | --- | --- |
| **P0** | Verify the capture path end to end (env reaches the CLI, `SessionStart` writes a `sessions` row); surface per-CLI hook status in settings instead of a blind "Enable agent hooks" button | a fresh claude pane produces a `sessions` row; settings shows which CLIs have hooks installed |
| **P1** ✅ | `ctx/store.rs` + `router.rs` + `chunk.rs` + `summarize.rs`, all pure logic with unit tests; no CLI integration yet | `cargo test` green; round-trip offload→search→read verified against fixtures |
| **P2** ✅ | `polakapi ctx-mcp` stdio server + `ctx_exec`/`ctx_search`/`ctx_read`/`ctx_list`; MCP registration written at hook-install time | a Claude pane can call `ctx_exec` and query the result back |
| **P3** ✅ | Storage tiers + promotion + self-ignoring `.polakapi/` | long session promotes into the project; `git status` stays clean |
| **P4** ✅ | Settings section nav + Context Mode section + persistence | settings survive restart; live panes react |
| **P5** | Hook enforcement: `PreToolUse` for claude (rewrite) and codex (deny) with a conservative matcher | oversized `gh --json` is intercepted; small commands untouched |
| **P6** | Savings line in the agent-context panel; opencode/cursor soft mode via opt-in rules file | savings visible per pane |

P0–P2 are the substance. P5 is where the ceiling lies and should be gated on
verifying `updatedInput` support against a real Claude Code build.

---

## 11. Risks and failure modes

- **Over-interception destroys trust.** A denied `Bash` the user wanted is far
  worse than a missed saving. Ship with a narrow matcher and a visible "context
  mode blocked this" signal.
- **Hooks are global, not per-project.** `~/.claude/settings.json` is the user's
  real settings file; `hooks.rs` merges without writing a backup and re-serializes
  the whole file, losing comments and formatting. Enabling context mode changes
  behaviour for Claude sessions started *outside* polakapi too. Write a `.bak`
  before the first mutation — that gap exists today regardless of this feature.
- **Small outputs are break-even.** Honour `BYPASS_MAX`.
- **Summaries can hide the answer.** Never summarize the exact-text kinds; when
  in doubt, index.
- **A malformed hook config is a hard error** (`hooks.rs:100-108`), so a user
  with JSONC comments in `settings.json` cannot enable hooks at all. Worth fixing
  alongside.
- **`ctx_exec` runs arbitrary commands** — no new privilege, since the agent
  could already run `Bash`, but it moves execution into a polakapi subprocess and
  so into polakapi's blast radius.

## 12. Why not vendor the npm package

`context-mode` is **Elastic License 2.0**. polakapi is MIT. ELv2 is not an OSI
open-source licence and carries use restrictions; shipping it inside an
MIT-licensed desktop app is a licensing question, not just a technical one.
Reimplementing the mechanism — which is well documented in their public
benchmark and not itself novel; it is tool-result offloading plus
code-execution-with-MCP — keeps polakapi's licence clean and lets the store reuse
the SQLite, hook and path infrastructure already here.

Two credibility notes on the upstream source: its benchmark file is solid,
reproducible engineering built on real fixtures, and worth mining. Its landing
page is not evidence — the "used by Microsoft/Google/Meta/Anthropic" logo wall
links every logo to `#` with no case studies.

## 13. Open questions

1. Does the installed Claude Code build support `updatedInput` in `PreToolUse`?
   The entire hard-enforcement path depends on it.
2. ~~Does `rusqlite 0.32`'s bundled SQLite include FTS5?~~ **Yes** — verified by
   `ctx::store::tests::fts5_is_available_and_indexes_chunks`, including the
   `porter` tokenizer, so stemming works.
3. Does `cursor-agent` (the CLI binary, not the IDE) expose any hook mechanism?
   Nothing was found documented.
4. Should offloaded data survive across sessions for `--continue` / `resume`
   flows, or be strictly per-session? Cross-session reuse is valuable but
   complicates eviction.
5. Where should opencode/cursor rules files be written, given that touching the
   user's project needs explicit consent?
