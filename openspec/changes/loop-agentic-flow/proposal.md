## Why

The `/loop` module is currently an empty Tauri window. We want to turn it into a 3-step agentic process (understand → decompose → execute) that automates complex engineering tasks using multiple LLM CLIs (claude, codex, opencode) — orchestrating specialized agents (analysis, implementation, reviewer, knowledge, integrator) with two execution modes (sequential and hybrid by batches).

The design is closed (see `docs/loop-agentic-design.html`) with 15 decisions made and the CLI invocation spike already validated.

## What Changes

- **New `/loop` window** with 3-step UI: problem refinement chat, phase editor with dependencies, run setup + execution.
- **Multi-CLI orchestration**: each Step 3 agent runs on an eligible CLI/model (claude/codex/opencode), invoked in one-shot mode (`-p` / `exec` / `run`) from a new Tauri command.
- **Phase system with `dependsOn`**: the Step 2 LLM proposes dependencies between phases; the system computes batches via topological sort for hybrid mode.
- **Reviewer loop with cap of 3 retries**: if not approved, the phase ends in state ⚠ and knowledge records the debt; the run continues.
- **Hybrid mode with per-batch integrator**: runs independent phases in parallel and consolidates knowledge between batches.
- **Global profiles**: editable `agent × CLI × model` matrix, persisted in `profiles.json` via `tauri-plugin-store`.
- **Editable global prompts**: 7 prompts (2 pre-phases + 5 agents) in the app's config dir, copied to the run tree at start.
- **Persistence and resume**: each run saves `state.json` with per-agent granularity; when an interrupted run is detected, it can be resumed from the last incomplete task.
- **Scoping to the active project**: `/loop` requires an active workspace project; it inherits `cwd`, suggested CLI, and path validation.
- Reuses the existing `import_user_path()` (`src-tauri/src/lib.rs:17`) which already ensures claude/codex/opencode are in the subprocess PATH.

## Capabilities

### New Capabilities

- `loop-problem-intake`: Step 1 — multi-turn chat with a CLI to refine the user's problem until producing `01-problem.md`. Each turn serializes the previous conversation into the prompt (one-shot, no persistent session).
- `loop-phase-decomposition`: Step 2 — generates the run's phase list with `logic.md` (always) + `visual.html` (optional, LLM decision) + `dependsOn[]`. UI with phase sidebar, inline editor, "edit with AI", and topology view derived from the DAG.
- `loop-execution-engine`: Step 3 — scheduler with sequential mode and hybrid mode (batches via topological sort, integrator between each batch). Orchestrates the 5 agents (analysis → implementation → reviewer with cap 3 → knowledge; integrator between batches in hybrid mode). State persisted in `state.json` with resume after crash.
- `loop-profiles`: global configuration of the `agent × CLI × model` matrix. JSON via `tauri-plugin-store` (`profiles.json`). Default with no profile loaded = all `claude/opus-4-7`. Overrides are temporary per run (explicit buttons to save as new profile or overwrite the loaded one). Validation on load: red slot if CLI/model does not exist.
- `loop-prompt-defaults`: management of the 7 default prompts (2 pre-phases + 5 agents). Globally editable in config dir (`prompts/*.md`). When creating a run, atomic copy from globals into the run tree. Editable inline in the Step 3 setup with `↑ reset to global` and `↓ save as global default` buttons per prompt.

### Modified Capabilities

None. There are no previous specs in `openspec/specs/`.

## Impact

**Frontend (TypeScript)**:
- `src/modules/loop/` — currently a placeholder; absorbs all the new UI (3 steps, phase editor, topology, setup with sidebar+editor, execution view by mode).
- `src/shared/persistence/` — new stores for `profiles.json` and the global `prompts/` (same pattern as `workspaces-store.ts:1`).
- `src/modules/workspaces/` — gate of "`/loop` does not open without an active project" + bar of "viewing project X · active run on project Y".

**Backend (Rust / Tauri)**:
- `src-tauri/src/loop_cli.rs` (new) — Tauri command `run_loop_agent` that invokes the configured CLI, normalizes output (claude JSON / codex `--output-last-message` / opencode stream) to a common `AgentResult`, with `tokio::time::timeout`.
- `src-tauri/src/lib.rs` — register the new command in the invoke handler (line ~74).
- `src-tauri/capabilities/loop.json` — command permissions for the `/loop` window.
- `src-tauri/Cargo.toml` — add `tokio` with feature `time` if not present; `serde_json` is already available via `serde`.

**Filesystem**:
- App config dir: `profiles.json`, `prompts/*.md` (7 files).
- Each project with runs: `<project>/.loop/runs/<run-id>/` with `01-problem.md`, `phases/`, `prompts/` (copy), `state.json`, `outputs/`, `outputs/batches/`.

**Does not affect**:
- Workspaces, terminals, notes panel, existing modules — `/loop` is additive.
- `workspaces.json` schema — the project path is still read as today.

**External dependencies**: no new runtime dependencies. The CLIs (`claude`, `codex`, `opencode`) are user requirements, not the app's. PATH bootstrap is already done.
