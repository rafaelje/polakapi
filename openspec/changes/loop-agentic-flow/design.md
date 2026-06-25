## Context

The `/loop` module is currently an empty Tauri window (`loop.html` + `src/modules/loop/loop.ts` placeholder, opened from `src/modules/agents-flow/loop-window.ts`). This proposal turns it into a 3-step agentic system that orchestrates multiple LLM CLIs (claude, codex, opencode) in one-shot mode.

The complete design and visual mockups are in `docs/loop-agentic-design.html` (15 closed decisions, validated CLI spike). This document extracts the technical decisions and trade-offs.

**Relevant repo context**:
- The app is Tauri 2 + Vite + TypeScript. Custom state management (no React/Vue) — see `src/modules/workspaces/state/` for the established pattern (reducer + controller + types).
- Local persistence: `tauri-plugin-store` with JSON files (see `src/shared/persistence/workspaces-store.ts:1`).
- Subprocesses: `std::process::Command::output()` (one-shot) and `portable_pty` (streaming) — both patterns already in `src-tauri/src/`.
- macOS PATH bootstrap already resolved in `src-tauri/src/lib.rs:17` (mentions claude/codex/opencode by name).
- The active workspace project exposes `path`, `activeCliId`, and path validation — all inheritable by `/loop`.

## Goals / Non-Goals

**Goals:**
- Let the user refine a problem with an LLM, decompose it into phases with dependencies, and execute it with specialized agents.
- Support two execution modes (sequential / hybrid by batches) selectable before the run.
- Multi-CLI per agent: each of the 5 Step 3 agents can use a different CLI/model.
- Resume after crash with per-agent granularity.
- Zero coupling between CLIs: contract via files on disk (not via inherited LLM sessions).
- Reuse what already exists in the repo (PATH bootstrap, plugin-store, Command pattern).

**Non-Goals:**
- Token-by-token streaming in Step 3 agents (one-shot is enough; only the Step 1 chat could benefit).
- Sharing profiles across machines (they are local globals, not committed).
- Per-agent FS sandboxing (decision: all agents can write; mitigation via post-hoc diff log).
- Prompt editing via UI separate from Settings (lives inline in the Step 3 setup).
- Per-project profile overrides (globals only in this iteration).
- Git worktrees per phase (discarded when choosing "parallel mode only for independent phases").

## Decisions

### 1. Contract between agents via files on disk
**Decision**: each agent reads files from the run (`logic.md`, `visual.html`, `analysis.md`, etc.) and writes **its own** file. There are no inherited LLM conversations between agents.

**Alternative considered**: passing the message stream from the previous CLI to the next. Rejected because it couples heterogeneous formats (claude JSON, codex JSONL, opencode events) and blocks mixing CLIs.

**Implication**: makes resume easier — just inspect which files exist and which do not.

### 2. "Hybrid" parallel mode with topological sort
**Decision**: parallel mode is not "all at the same time"; it uses `dependsOn[]` declared on each phase to compute batches. Standard topological sort: batch 1 = phases with no dependencies, batch N+1 = phases whose dependencies are all in batches ≤ N.

**Alternative considered**: "pure" parallel with git worktrees per phase. Rejected due to operational complexity (merges, conflicts, cleanup) and because it shifted the problem to a blind final integrator.

**Implication**: the integrator runs **per batch**, not just at the end. It allows detecting conflicts early and propagating knowledge between batches.

### 3. One-shot CLI with serialized history in multi-turn
**Decision**: all CLI invocations are one-shot (`claude -p`, `codex exec`, `opencode run`). In Step 1 (multi-turn), each turn serializes the previous conversation into the prompt.

**Alternative considered**: persistent sessions with `--resume` flags. Rejected because (a) it introduces state in the CLI that the app does not control, (b) each CLI has its own session id format, (c) the spike confirmed that one-shot is enough and predictable.

**Implication**: per-turn cost grows linearly with history (the CLI's prompt cache can mitigate it). Acceptable for short refinement conversations.

### 4. Reviewer cap at 3 with warning propagation
**Decision**: the reviewer has exactly 3 attempts. On the fourth it is discarded — the phase ends with state `warning` (⚠) and the knowledge agent still runs with the last output. The debt is noted in `knowledge.md` so the dependent phase(s) can see it.

**Alternative considered**: ask the user when the cap is reached. Rejected because it breaks the automatic flow and adds friction to long runs.

**Implication**: the final run summary shows which phases ended unapproved. The user can re-run those phases manually.

### 5. JSON storage, not SQLite, for profiles and prompts
**Decision**: both live in the app's config dir via `tauri-plugin-store` (`profiles.json`) or loose files (`prompts/*.md`).

**Alternative considered**: SQLite with `rusqlite`. Rejected because (a) 1-20 profiles do not justify a relational engine, (b) it introduces a new dependency (+1MB binary), (c) it breaks consistency with `workspaces.json`, (d) historical runs are not indexed globally — they live as files in `<project>/.loop/runs/`.

**Implication**: if cross-project run indexing with queries is needed in the future, SQLite can be added for that without touching profiles/prompts.

### 6. Unrestricted FS permissions + auditing
**Decision**: all agents can write any file. There is no per-agent sandboxing.

**Alternative considered**: post-hoc diff discarding changes outside the expected `.md`. Rejected due to complexity (what counts as "expected" varies per context) and because it leaves the decision to the user.

**Mitigation**: each agent is invoked with a `git stash` before and after to snapshot its diff. It is saved in `<run>/outputs/<phase>/<agent>.diff` (or equivalent) for auditing.

### 7. Persistent state with per-agent granularity
**Decision**: `state.json` per run with fields: `currentBatch`, `phases[id]: { status, lastAgent, retryAttempt, warning }`, `integrators[batchId]: status`, `lastHeartbeat`. Resume detects incomplete tasks and relaunches the agent that was in progress (discarding partial outputs).

**Alternative considered**: structured log (event-sourcing) reconstructed on open. More robust but overkill — a well-defined snapshot covers the case.

### 8. Profile validation on load without auto-fallback
**Decision**: if a CLI is not installed or a model does not exist, the slot is marked red and the run cannot execute until the user corrects it. No automatic suggestions.

**Alternative considered**: automatic fallback to "claude/opus-4-7" if the slot breaks. Rejected because it changes the expected behavior of the run silently.

### 9. Global prompts with atomic copy to the run
**Decision**: the 7 prompts live in `<app-config>/prompts/`. When creating a run, they are copied atomically to `<run>/prompts/`. Edits in the run do not propagate; edits to globals do not affect already created runs.

**Alternative considered**: reference by path (run points to the global). Rejected because it breaks the immutability of the run and makes reproducible resume difficult.

### 10. Inline UI in the Step 3 setup (no separate settings)
**Decision**: prompt editing lives in a unified Step 3 setup view — sidebar of the 7 prompts + main editor with CLI/model dropdowns. No dedicated Settings screen.

**Alternative considered**: global Settings screen. Rejected by user preference (decision 15 in the design doc): keep the entire run lifecycle visible on a single surface.

## Risks / Trade-offs

| Risk | Mitigation |
|--------|-----------|
| Model aliases change between versions (e.g. `haiku-4-5` 404 vs `haiku` OK) | Validation on profile load marks slot in red. Document supported `cli × model` matrix with tested version. |
| Uncontrolled token cost with multi-CLI (each agent bills separately) | Budget visible live broken down per agent. Automatic pause when exceeded. |
| Reviewer loop oscillating without converging | Hard cap of 3 attempts. Beyond that, phase ends with warning and the flow continues. |
| Parallel mode + FS conflicts not detected due to incorrect dependencies | The batch integrator runs `git diff --check` before approving the batch. A conflict pauses the run. |
| Agents with total permissions corrupt the FS uncontrollably | `git stash` per agent to preserve the snapshot, exportable diff. The user reviews post-mortem. |
| The application closes mid-run without saving state | Heartbeat every N seconds in `state.json` + resume detect on next project open. |
| The Step 2 LLM declares dependencies wrong (phases that actually overlap) | The user reviews the topology view before executing. The batch integrator detects real conflicts. |
| Hung subprocess (CLI does not respond) | `tokio::time::timeout` with default 300s. On timeout, kill the subprocess and report as failure. |
| `--dangerously-skip-permissions` in claude / `--sandbox` in codex require configuration | Document the matrix: the implementation agent runs unrestricted; analysis/reviewer/knowledge with `--print` (read-only de facto). |
| Bundling the 7 default prompts in the binary | Embed with `include_str!` in Rust or Tauri resources. Decision deferred to implementation. |

## Migration Plan

There is no data migration — `/loop` is additive. New files live in new places:
- Config dir: `profiles.json`, `prompts/*.md` (created on-demand on first post-update launch)
- Per project: `<project>/.loop/runs/<run-id>/...` (created when starting the first run)

**Rollback**: the user can delete `<app-config>/profiles.json`, `<app-config>/prompts/`, and `<project>/.loop/` without affecting the rest of the app. The `/loop` module can coexist or disappear without touching workspaces, terminals, or notes.

**Suggested implementation order** (also reflected in `tasks.md`):
1. Backend of the Tauri command `run_loop_agent` + tests with smoke calls.
2. Profiles store + global prompts (bundled defaults, atomic copy to the run).
3. Step 1 UI (simpler, validates the one-shot pattern + history serialization).
4. Step 2 UI (more complex: editor + topology + edit with AI).
5. Sequential engine for Step 3 (no batches, no integrator).
6. Hybrid engine with batches + integrator.
7. Persistence + resume.

Each step is a coherent PR, valuable on its own. If something blocks later (e.g. resume), the previous steps remain useful.

## Open Questions

None blocking implementation. The things to decide during coding (not at design time) are:

- **How to bundle the 7 default prompts**: `include_str!` in Rust vs Tauri resources vs files copied by Vite to `dist/`. The decision is made when preparing the initial seed commit.
- **Exact default of the per-agent timeout**: 300s seems reasonable, but it could be adjusted based on the model (opus takes longer than haiku). Configurable globally + per-run override in V2.
- **Heartbeat frequency to detect a crash**: 5s by default, recalibrate if it adds UI noise.
- **`knowledge.md` size**: stays as hard limit ~2k tokens (via prompt). If large runs suffer from this, add secondary compression.
