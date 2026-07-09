# /adversarial review — Feature Plan

Multi-round adversarial code review between two independent LLM CLI slots
(e.g. `claude` + Opus at high effort vs `codex` + GPT at xhigh effort),
launched from a new button in the agents flow panel. The debate reviews the
**branch-vs-base diff** (PR-style) of the active project and produces a
**report only** — no agent ever modifies the working tree.

Decisions already made:

- **Target:** diff of the current branch against its base (`merge-base` with
  `main`/`master`/`origin/HEAD`), not the uncommitted working tree.
- **Scope:** report-only. No fixer stage in v1.
- **Protocol:** option C — critic finds issues, defender (different CLI/model)
  tries to refute each one, N rounds of rebuttal, deterministic final report.

---

## 1. User experience

### 1.1 Entry point

A third button in the agents flow sidebar (`index.html`, next to `/loop` and
`/prompts`):

```html
<button type="button" class="agents-flow-btn" id="open-adversarial-review">/adversarial review</button>
```

Clicking opens a dedicated Tauri window (label `adversarial-review`, url
`adversarial.html`) following the exact single-instance pattern of
`src/modules/agents-flow/loop-window.ts` (focus existing window on second
click). Mounted from `src/app/app-controller.ts` alongside the other two
buttons.

### 1.2 Window flow (3 steps, simpler than /loop's 4)

Reuses the /loop gate pattern (`run-context.ts`): the window reads the shared
`workspaces.json` store, requires an active project with a valid path, and
refreshes on focus.

**Step 1 — Setup**

- Project banner (name + path, read-only, from the active project).
- **Base ref selector**: auto-detected default (see §3.2) with a free-text
  override. Shows the resolved merge-base commit and a diff summary
  (files changed / insertions / deletions) as validation that the diff is
  non-empty before enabling ▶ run.
- **Two agent slots** — `critic` and `defender` — freely pairable matchup
  (see §1.3 for the full slot spec): any CLI×model×effort on each side,
  including the same CLI on both.
- **Rounds**: 1–3 (default 2). One round = critic pass + defender pass.
- **Blocking severity**: threshold for the final verdict (default `major`,
  see §2.6).
- **Prompt overrides**: same per-run editable prompt panel as /loop step 3,
  scoped to the two new prompts.
- Timeout per agent invocation (reuse the /loop default).
- Profiles: save/load named `{critic, defender, rounds, baseRef}` presets
  (separate store from loop profiles, see §5.2).

**Step 2 — Run (live)**

- Vertical timeline of rounds: `R1 critic → R1 defender → R2 critic → …`,
  each with status chip (pending / running / done / error), tokens in/out,
  cost, elapsed.
- Live findings counter: `open / confirmed / refuted / disputed`.
- Abort button. Heartbeat indicator (reuse `heartbeat.ts`).
- Navigating back to Step 1 aborts the run (same rule as /loop).

**Step 3 — Report**

- Rendered findings table: severity, file:line, claim, final status
  (confirmed / disputed / withdrawn), which model raised/refuted it.
- Final verdict banner: `APPROVED` or `CHANGES REQUESTED` per the verdict
  policy (§2.6), with the applied threshold shown next to it.
- Buttons: "open report in editor" (reuse `open_file_in_editor`), "open run
  folder" (reuse `open_in_explorer`), "new review" (back to Step 1 with a
  fresh runId).

### 1.3 Slot selection — free CLI×model matchups

The critic and defender slots are fully independent; any pairing is valid:

| Matchup | Example |
|---|---|
| cross-CLI | `claude` + Opus (high) vs `codex` + GPT (xhigh) |
| same CLI, different models | `claude` + Opus vs `claude` + Sonnet |
| same CLI, same model | `claude` + Opus vs `claude` + Opus (allowed, warned) |
| any other combination | `codex` + GPT vs `opencode` + `anthropic/claude-sonnet-4-5` |

Per-slot controls (mirroring /loop step 3's slot editor):

- **CLI dropdown** — `claude` | `codex` | `opencode`, each validated
  independently against PATH with the existing red-slot gating; ▶ run stays
  disabled while either slot is red. Two slots on the same CLI validate once
  (cache by CLI name, as /loop already does across its five roles).
- **Model** — free-text input pre-filled per CLI via `defaultModelFor()`
  (`claude-opus-4-7` / `gpt-5` / `anthropic/claude-sonnet-4-5`), with a
  datalist of recent models the user has typed (persisted per CLI in the
  profiles store). Switching CLI resets the model to that CLI's default.
- **Effort** — `default | low | medium | high | xhigh`; rendered disabled
  with "n/a" when the selected CLI has no effort mapping (see §3.1).

Mirror-matchup warning: if both slots resolve to the identical
CLI+model+effort triple, show a non-blocking warning ("both debaters are the
same model — refutation quality drops without model diversity"). It stays
allowed on purpose: same-model debate is still useful (self-consistency
check) and it is the only option when just one CLI is installed.

The `{critic, defender}` pair is the core of a saved profile (§5.2), so
recurring matchups like "Opus vs GPT xhigh" are one click to restore.

---

## 2. Debate protocol

### 2.1 Roles and rounds

```
Round 1:  critic   → reads diff, emits findings F1..Fn (only round where new findings may be created)
          defender → for each open finding: refute | concede | dispute, with evidence
Round 2+: critic   → rebuts each disputed/refuted finding: withdraw | maintain (with new evidence)
          defender → same as round 1, over the findings still in play
Final:    deterministic TypeScript code (no LLM) folds statuses into the report
```

Rules that make it converge:

- New findings are only allowed in the critic's **first** pass. Later passes
  may only argue existing findings (prevents infinite expansion).
- A finding both agents agree on (critic maintains, defender concedes) is
  **confirmed** and leaves the debate — it is not re-argued in later rounds.
- A finding the critic withdraws is **withdrawn** and leaves the debate.
- Whatever is still contested after the last round is reported as
  **disputed**, with both sides' final arguments quoted.
- **Silence counts against its own side**: a finding in play that a defender
  pass does not address is an implicit `concede`; a challenged finding a
  critic rebuttal does not address is an implicit `withdraw`. The reducer
  records these with the argument `"(not addressed — implicit)"` so the
  report shows them honestly. This keeps both prompts honest and guarantees
  every finding reaches a terminal state.

### 2.2 Finding lifecycle (state machine)

```
open ──(defender: concede)──────────────► confirmed
open ──(defender: refute)───► challenged ──(critic: withdraw)──► withdrawn
                              challenged ──(critic: maintain)──► contested ──(next defender pass)──► …
(rounds exhausted while challenged/contested)────────────────► disputed
```

Implemented as a pure reducer in `src/modules/adversarial/core/findings.ts`
with exhaustive unit tests — this is the heart of the feature and must not
depend on Tauri.

### 2.3 Structured output contract

Each agent pass must end its output with a fenced JSON block:

```json
{
  "pass": "critic" | "defender",
  "findings": [
    {
      "id": "F1",                    // assigned by the critic, stable across rounds
      "file": "src/foo.ts",
      "line": 42,                    // optional
      "severity": "critical" | "major" | "minor" | "nit",
      "claim": "one-sentence defect statement",
      "action": "new" | "maintain" | "withdraw" | "refute" | "concede" | "dispute",
      "argument": "evidence for this round's action"
    }
  ]
}
```

Field requirements per action: `file`, `line`, `severity`, `claim` are
required when `action` is `new`; for every other action only `id`, `action`
and `argument` are read (extra fields are ignored). Severity is assigned by
the critic at creation and never re-graded — arguing severity is what
`dispute` is for.

Parsing (`src/modules/adversarial/core/parse.ts`):

- Extract the **last** fenced ```json block (agents echo examples; the last
  block is the answer — same lesson as the `parseReviewVerdict` offset fix).
- On malformed JSON: one automatic retry appending a "your previous output
  failed to parse, emit only the JSON block" instruction. The format retry
  increments the pass's `retries` counter (shared with transport-level
  retries). Second failure marks the pass `error` and stops the run (state
  persisted for resume).
- Unknown finding ids / illegal actions for the current phase are dropped with
  a warning surfaced in the run log (never crash the reducer). Findings in
  play that are *missing* from the pass get the implicit action defined in
  §2.2.

### 2.4 Prompts

Two new bundled prompts, **already authored** at
`src-tauri/prompts/adversarial-critic.md` and
`src-tauri/prompts/adversarial-defender.md` (inert until M4 registers them):

- `adversarial-critic.md` — covers both modes (the user input declares
  `MODE: find` or `MODE: rebuttal`); find mode defines the severity taxonomy
  and requires evidence anchored in the diff; rebuttal mode requires *new*
  evidence to `maintain` and frames `withdraw` as convergence, not defeat.
- `adversarial-defender.md` — refute/concede/dispute instructions; explicitly
  primed to be skeptical ("kill the false positives") but with the symmetric
  duty to concede real defects; documents the implicit-concede rule for
  unaddressed findings.

Both must be added in **two places kept manually in sync** (documented
constraint, see `src/modules/loop/types.ts:43`):

- `PROMPT_NAMES` in `src-tauri/src/loop_prompts.rs` (7 → 9) + two new files in
  `src-tauri/prompts/` (build fails if missing, thanks to `include_str!`).
- `LOOP_PROMPT_NAMES` in `src/modules/loop/types.ts` — or better, a new
  `ADVERSARIAL_PROMPT_NAMES` const in the adversarial module, with the Rust
  side accepting the union. Keeping a separate TS constant avoids polluting
  /loop's `promptToRole`/`promptBlurb` switches.

The global-prompt editing window (`/prompts`) picks the new names up
automatically once they are in `PROMPT_NAMES` + `bundled_content`.

### 2.5 Agent input composition

Per pass, the user input (built in `core/debate-input.ts`, mirroring
`agent-input.ts`) contains:

- The branch diff (see §3.2) — critic round 1 gets the full diff; later
  passes get the diff **plus** the current findings ledger (JSON) and the
  opposing side's latest arguments.
- Diff size guard: if the diff exceeds ~150 KB, truncate per file with a
  "files omitted" manifest and record a `diffTruncated` warning in the state
  (visible in the report header). v1 does not chunk.

### 2.6 Verdict policy

Severity order: `critical > major > minor > nit`. The setup exposes a
**blocking severity** threshold (default `major`).

- `CHANGES REQUESTED` ⇔ at least one **confirmed** finding with severity at
  or above the threshold.
- Everything else is `APPROVED` — including runs with confirmed findings
  below the threshold (listed in the report as non-blocking) and runs with
  only disputed findings.
- **Disputed findings never block.** They are humans' to arbitrate; the
  report lists them prominently with both final arguments.
- Withdrawn findings appear only as a count.
- The verdict is computed by `report.ts` from the final ledger — pure
  function, exhaustively unit-tested, no LLM involvement.

---

## 3. Backend (Rust) changes

### 3.1 `run_loop_agent`: optional `effort` parameter

Add `effort: Option<String>` to the existing command (backward compatible —
/loop callers simply don't send it). Mapping in `loop_cli.rs`:

| CLI | Mapping |
|---|---|
| `codex` | `-c model_reasoning_effort=<effort>` |
| `claude` | verify current CLI: if a `--effort`-equivalent flag exists use it; otherwise set the documented env var (e.g. `MAX_THINKING_TOKENS` tier) on the spawned process. Spike task in M1. |
| `opencode` | provider-dependent; v1: ignore with a logged warning. |

The existing per-invocation log line in `polakapi-loop-cli.log` gains an
`effort=` field.

### 3.2 New git commands (in a new `src-tauri/src/git_review.rs`)

- `git_detect_base_ref { projectPath } -> String` — resolution order:
  `origin/HEAD` symbolic ref → `main` → `master`; error if none exists or the
  current branch **is** the base (nothing to review).
- `git_branch_diff { projectPath, baseRef } -> { mergeBase, diff, stat }` —
  validates `baseRef` first (`git rev-parse --verify <baseRef>`; reject
  anything that does not resolve, with a typed error the UI shows inline),
  then `git merge-base <baseRef> HEAD` and `git diff <mergeBase>...HEAD` plus
  `--stat` summary. Reject if the diff is empty. Uses the same
  path-validation helpers as `loop_git_diff_snapshot`. Step 1 calls it on
  base-ref blur: an invalid ref or empty diff keeps ▶ run disabled with the
  error next to the field.

### 3.3 Run storage commands

New namespace `<project>/.adversarial/runs/<runId>/` with thin commands
reusing the shared fs/atomic-write helpers from `loop_prompts`/storage:

```
adv_read_run_file    { projectPath, runId, file }           -> String
adv_write_run_file   { projectPath, runId, file, content }  -> ()      # atomic
adv_write_state_file { projectPath, runId, content }        -> ()      # atomic, state.json
adv_ensure_run_prompt{ projectPath, runId, name }           -> ()      # lazy seed from global
```

`file` is validated against an allowlist pattern — `diff.patch`,
`findings.json`, `report.md`, `round-<n>-(critic|defender).md` — anything
else is rejected (path-traversal guard, same posture as the loop storage
commands; `runId` goes through the existing `safe_run_id` sanitizer).
Files per run:

```
.adversarial/runs/<runId>/
  prompts/adversarial-critic.md        # per-run copy, lazily seeded from global
  prompts/adversarial-defender.md
  diff.patch                           # frozen input diff (report is reproducible)
  round-1-critic.md                    # raw agent output per pass
  round-1-defender.md
  round-2-critic.md ...
  findings.json                        # ledger after every reducer step
  state.json                           # scheduler state for resume
  report.md                            # final deterministic report
```

Add `.adversarial/` to the same ignore guidance as `.loop/` (README note; the
target project's `.gitignore` is the user's call, mirroring current /loop
behavior).

### 3.4 Capabilities

No new Tauri capabilities expected — everything goes through invoke commands,
same as /loop. Register the new commands in `lib.rs`/`commands.rs`.

---

## 4. Frontend structure

New module mirroring the loop layout:

```
adversarial.html                         # new Vite input (vite.config.ts rollupOptions.input)
src/modules/agents-flow/adversarial-window.ts   # button + single-instance window (copy loop-window.ts)
src/modules/adversarial/
  adversarial.ts                         # entry: gate + chrome, mirrors loop.ts
  adversarial.css
  types.ts                               # DebateSlot (AgentSlot + effort), DebateSettings, prompt names
  core/
    findings.ts                          # finding reducer/state machine (pure, tested)
    parse.ts                             # fenced-JSON extraction + validation (pure, tested)
    debate-input.ts                      # per-pass input builder (pure, tested)
    report.ts                            # state → report.md renderer (pure, tested)
    scheduler/
      debate-scheduler.ts                # round loop, retries, abort, totals
      invokers.ts                        # Tauri invoke bindings (runAgent w/ effort, adv_* commands, git_*)
      persistence.ts                     # state.json write-through + resume hydration
      store.ts                           # observable state store (adapted from loop's StateStore)
      types.ts
  step1-setup/  (state.ts, view.ts, index.ts)
  step2-run/    (state.ts, view.ts, index.ts)
  step3-report/ (state.ts, view.ts, index.ts)
```

Shared code reused as-is: `shared/tauri/invoke`, toasts/modals, listener-bag,
`heartbeat.ts` (import from loop or promote to `src/shared/`), workspaces
store reader, CLI validation from /loop step 3 helpers.

`AgentSlot` gains `effort?: string` in `src/modules/loop/types.ts` (optional →
no loop profile migration needed) and /loop step 3 can expose it later for
free.

### 4.1 Scheduler state (persisted)

```ts
type Severity = "critical" | "major" | "minor" | "nit";
type FindingStatus = "open" | "challenged" | "contested" | "confirmed" | "withdrawn" | "disputed";
type DebateAction = "new" | "maintain" | "withdraw" | "refute" | "concede" | "dispute";
type PassRole = "critic" | "defender";

interface FindingEvent {
  round: number;
  role: PassRole;
  action: DebateAction;
  argument: string;                      // "(not addressed — implicit)" for implicit actions
}

interface Finding {
  id: string;                            // "F1"…, assigned by the critic in round 1
  file: string;
  line?: number;
  severity: Severity;                    // fixed at creation, never re-graded
  claim: string;
  status: FindingStatus;
  history: FindingEvent[];               // full transition log — feeds report + resume
}

interface FindingLedger {
  findings: Finding[];
  appliedPasses: Array<{ round: number; role: PassRole }>;  // resume invariant, see below
}

interface DebateState {
  status: "idle" | "running" | "paused" | "completed" | "aborted" | "error";
  settings: { projectPath, runId, baseRef, mergeBase, rounds,
              critic: DebateSlot, defender: DebateSlot,
              blockingSeverity: Severity, timeoutSecs };
  passes: Array<{ round: number; role: PassRole;
                  status: "pending" | "running" | "done" | "error";
                  tokensIn: number; tokensOut: number; costUsd: number; retries: number; message?: string }>;
  findings: FindingLedger;               // output of the reducer, source of truth for the report
  totals: { tokensIn, tokensOut, costUsd };
  lastHeartbeat: number;
  diffTruncated: boolean;
}
```

`findings.json` is the serialized `FindingLedger`, rewritten atomically after
every reducer step.

Resume: on window open with an existing non-terminal `state.json`, offer the
same resume banner pattern as /loop (`resume-detector.ts` as reference). The
invariant is simpler here: a pass is committed iff its `round-N-role.md` file
exists **and** `{round, role}` appears in `findings.appliedPasses` — passes
are re-run otherwise. `running` passes rewind to `pending` on hydration.

### 4.2 Report generation

`report.md` is rendered by TypeScript from the final ledger — never by an
LLM — so totals, counts and statuses are exact. Sections: header (project,
branch → base, merge-base, models/efforts, rounds, cost), verdict, confirmed
findings (severity-sorted), disputed findings (both final arguments),
withdrawn count, truncation warning if any.

---

## 5. Persistence & profiles

### 5.1 Run artifacts

On-disk under the target project (§3.3) — consistent with /loop, survives app
restarts, diffable by the user.

### 5.2 Profiles

New plugin-store file `adversarial-profiles.json`
(`{ profiles: [{ id, name, createdAt, critic, defender, rounds }], schemaVersion: 1 }`).
Kept separate from loop profiles: different shape, independent evolution.

---

## 6. Testing

Vitest (all pure modules, no Tauri):

- `findings.test.ts` — every lifecycle transition incl. illegal actions,
  double-concede, withdraw-after-confirm rejection, round-exhaustion →
  disputed, implicit concede/withdraw for unaddressed findings (§2.2).
- `parse.test.ts` — last-JSON-block extraction, malformed JSON, unknown ids,
  echoed examples in prose, empty findings array, required-fields-per-action
  validation (§2.3).
- `debate-scheduler.test.ts` — happy path (2 rounds), abort mid-pass, parse
  retry then error, resume from each pass boundary, token/cost accumulation
  (mirror `run-scheduler.test.ts` fake-invoker style).
- `report.test.ts` — snapshot of report.md for a fixed ledger + verdict
  policy (§2.6): threshold boundaries per severity, disputed-only runs →
  APPROVED, below-threshold confirmed findings listed as non-blocking.
- `debate-input.test.ts` — truncation threshold, ledger embedding.

Rust:

- `git_review.rs` — base-ref detection order, merge-base diff on a fixture
  repo, empty-diff and on-base-branch rejection (mirror existing loop storage
  test style).
- `loop_cli.rs` — effort flag mapping per CLI (arg-construction unit tests).
- `loop_prompts.rs` — existing tests updated for 9 prompt names.

Gate: `pnpm run check` green; /loop must be untouched behaviorally (only the
optional `effort` param and shared helper promotion touch its code paths).

---

## 7. Milestones

| # | Deliverable | Touches |
|---|---|---|
| **M1** | `effort` in `AgentSlot` + Rust mapping (incl. claude-CLI spike); log field | `loop/types.ts`, `loop_cli.rs` |
| **M2** | Git review commands + window scaffold (button, `adversarial.html`, Vite input, gate, empty steps) | `git_review.rs`, `agents-flow/`, `app-controller.ts`, `index.html`, `vite.config.ts` |
| **M3** | Debate core: types, reducer, parser, input builder, report renderer — fully tested, no UI | `adversarial/core/` |
| **M4** | Register the already-authored prompts (`src-tauri/prompts/adversarial-*.md`) in `PROMPT_NAMES`/`bundled_content`; `adv_*` storage commands | `loop_prompts.rs`, `commands.rs` |
| **M5** | Scheduler + Step 1/2 UI wired end-to-end (live run against real CLIs) | `adversarial/` |
| **M6** | Step 3 report UI, resume banner, profiles, notifications, polish | `adversarial/` |

M1 and M3 are independent and can proceed in parallel; M5 depends on all of
M1–M4.

---

## 8. Risks & mitigations

- **Structured-output drift** (agents not emitting valid JSON): strict
  contract + one format-retry + error state that resumes cleanly. Prompts
  include a literal output template.
- **`claude` effort flag uncertainty**: spike in M1; worst case effort is a
  codex-only feature at launch, slot UI shows "n/a" for claude.
- **Huge PR diffs**: 150 KB truncation with visible warning; chunked review is
  explicitly out of scope for v1.
- **Debate non-convergence / token burn**: hard cap of 3 rounds, new findings
  only in round 1, confirmed/withdrawn findings leave the debate, live cost
  totals in Step 2.
- **Prompt-name sync (TS ↔ Rust)**: existing documented constraint; both
  edits land in the same commit (M4) with the Rust test updated.
- **Two models agreeing on a false positive**: accepted limitation of v1
  (defender is explicitly primed as skeptic); a third arbiter slot is a
  possible v2.

---

## 9. Out of scope (v1)

- Fixer stage applying confirmed findings (explicit decision: report-only).
- Working-tree diff target (branch-vs-base only; the /loop review covers
  in-flight work).
- More than 2 debaters, arbiter model, or per-finding model routing.
- Diff chunking for very large PRs.
- Exporting the report as a GitHub PR comment.
