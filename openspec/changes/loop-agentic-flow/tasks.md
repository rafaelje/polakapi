## 1. Tauri backend — `run_loop_agent` command

- [x] 1.1 Create `src-tauri/src/loop_cli.rs` with the struct `AgentResult { text, tokens_in, tokens_out, cost_usd, session_id, error }`
- [x] 1.2 Implement `#[tauri::command] async fn run_loop_agent(cli, model, cwd, system_prompt_path, user_input, timeout_secs)` with `tokio::time::timeout` wrapping `std::process::Command::output()`
- [x] 1.3 Parse claude output (`--output-format json`) → `AgentResult`
- [x] 1.4 Parse codex output (`--output-last-message <file>` + `--json` for tokens) → `AgentResult`
- [x] 1.5 Parse opencode output (`--format json` stream) → `AgentResult` extracting the last agent message
- [x] 1.6 Error handling: CLI not found, timeout, exit code ≠ 0, malformed JSON
- [x] 1.7 Register the command in `src-tauri/src/lib.rs` (invoke_handler ~line 74)
- [x] 1.8 Add command permission in `src-tauri/capabilities/loop.json`
- [x] 1.9 Verify that `tokio` with feature `time` is in `Cargo.toml`
- [ ] 1.10 Manual smoke test: invoke with claude/haiku from the devtools console, confirm `AgentResult` parsed

## 2. Persistence — global profiles and prompts

- [x] 2.1 Create `src/shared/persistence/loop-profiles-store.ts` following the pattern of `workspaces-store.ts` (load + queueSave with debounce + schemaVersion)
- [x] 2.2 Define types `LoopProfile`, `LoopProfilesState`, `AgentSlot { cli, model }` in `src/modules/loop/state/types.ts`
- [x] 2.3 Bundle the 7 default prompts as strings (`include_str!` in Rust or Vite resources) — decide as appropriate
- [x] 2.4 Implement Tauri command `loop_ensure_prompts_dir` that verifies/creates `<app-config>/prompts/` and restores missing files from the bundled ones
- [x] 2.5 Implement `loop_read_global_prompt(name)` / `loop_write_global_prompt(name, content)` for the 7 files
- [x] 2.6 Implement `loop_create_run(projectPath, runId)` that creates `<project>/.loop/runs/<runId>/` with the `prompts/` subfolder copied atomically from the globals
- [x] 2.7 Implement `loop_validate_cli_model(cli, model)` that returns `{ ok, reason }` checking PATH and a ping to the model
- [x] 2.8 Unit tests of the store (`workspaces-controller.test.ts` as a reference for the shape)

## 3. /loop window — chrome and gate

- [x] 3.1 Update `src/modules/loop/loop.ts` to mount the 3-step router
- [x] 3.2 Active project gate: if `activeProjectId` is null, show "pick a project first" and CTA to the workspace
- [x] 3.3 Invalid path gate: if `pathInvalid`, show the path error
- [x] 3.4 Persistent header with: project name, run-id, current step (1/2/3), "abandon run" button
- [x] 3.5 Base styles in `src/modules/loop/loop.css` reusing tokens from the main app

## 4. Step 1 — Problem intake chat

- [x] 4.1 Chat component with large input, list of turns, CLI selector (claude/codex/opencode)
- [x] 4.2 History serialization logic: each turn builds a prompt with all previous turns before invoking `run_loop_agent`
- [x] 4.3 Persist the conversation in `<run>/01-problem-draft.md` after each turn (for resume)
- [x] 4.4 "edit system prompt" button that opens the editor over `<run>/prompts/problem-intake.md`
- [x] 4.5 "consolidate problem.md →" button that invokes a final turn asking for a structured summary and writes it to `<run>/01-problem.md`
- [x] 4.6 Validate that there is at least 1 turn before enabling "consolidate"
- [x] 4.7 Navigation to Step 2 on consolidation

## 5. Step 2 — Phase decomposition

- [x] 5.1 Tauri command / TS module that invokes `phase-decomposition.md` with `01-problem.md` and parses the response into a list of `Phase { id, name, dependsOn[], hasVisual }`
- [x] 5.2 Create the folders `<run>/phases/<NN>-<slug>/` with `logic.md` (always) and `visual.html` (when `hasVisual`)
- [x] 5.3 Phase sidebar with: number, name, `md`/`html` badges, dependency line below
- [x] 5.4 Tabs `logic.md` / `visual.html` in the main panel; hide `visual.html` tab if the phase does not have it
- [x] 5.5 Inline text editor (Monaco or styled textarea — decide based on footprint)
- [x] 5.6 Toolbar with "save", "edit with AI" (selection + instruction → diff)
- [x] 5.7 `dependsOn` editor: multi-select with the other phases; cycle detection on save
- [x] 5.8 "+ add phase" button + delete phase with confirmation if it has dependents
- [x] 5.9 Read-only "execution topology" view: topological sort → render by batches in lanes
- [x] 5.10 "→ Step 3" button available when all phases have at least `logic.md`

## 6. Step 3 — Unified setup

- [x] 6.1 Top bar with active project + project's suggested CLI
- [x] 6.2 Mode selector (sequential / hybrid) with automatic "parallel mode equivalent to sequential" detection if everything is linear
- [x] 6.3 Loaded profile dropdown + "save as…" / "save" button
- [x] 6.4 Sidebar with the 7 prompts (2 pre-phases + 5 agents), each showing current CLI/model + default/modified badge
- [x] 6.5 Main panel with: agent name, inputs/outputs description, CLI/model dropdowns, "↑ reset to global" and "↓ save as global default" buttons, prompt textarea
- [x] 6.6 Live detection of `default` vs `modified` comparing against the current global
- [x] 6.7 Per-slot validation on profile load (CLI in PATH + valid model) with red marking
- [x] 6.8 Config row: max retries (default 3 read-only for now), token budget, failure behavior (read-only "propagate warning")
- [x] 6.9 "▶ execute run" button disabled if there are red slots

## 7. Step 3 — Sequential engine

- [x] 7.1 Create `src/modules/loop/state/run-scheduler.ts` with the scheduler's state machine
- [x] 7.2 Implement the per-phase pipeline: analysis → impl → reviewer (≤ 3 tries) → knowledge
- [x] 7.3 Each step invokes `run_loop_agent` with the configured CLI/model and persists the output in `<run>/outputs/<phase>/<agent>.md`
- [x] 7.4 Diff snapshot per agent: `git stash` before/after → `<run>/outputs/<phase>/<agent>.diff`
- [x] 7.5 Cap logic: at the 3rd retry without approval, mark phase `warning`, note the debt in the knowledge agent's input, continue
- [x] 7.6 Persist `state.json` after each agent with `lastHeartbeat`
- [x] 7.7 Execution view (sequential mode): vertical phase timeline with 4 agent columns; pending/running/done/warning states
- [x] 7.8 Live budget (tokens + accumulated USD, breakdown per agent)
- [x] 7.9 "pause run" and "abort run" buttons

## 8. Step 3 — Hybrid engine with batches

- [x] 8.1 Topological sort algorithm over `phases[].dependsOn` → `batches: Phase[][]`
- [x] 8.2 Execute batch phases in parallel (`Promise.all` over individual pipelines)
- [x] 8.3 Implement integrator agent: input = all batch outputs + diffs; output = consolidated `knowledge.md` in `<run>/outputs/batches/batch-<N>/knowledge.md`
- [x] 8.4 FS conflict detection by the integrator (`git diff --check` or equivalent over the impl stashes)
- [x] 8.5 On conflict: pause the run and show report (continue / abort / re-execute)
- [x] 8.6 Pass the consolidated knowledge from batch N as additional input to batch N+1 phases
- [x] 8.7 Execution view (hybrid mode): batches visually separated, mini-cards per phase with progress bars per stage, warning banner if any phase reached the cap
- [x] 8.8 Live integrator: own card between batches showing "waiting" / "running" / "✓"

## 9. Persistence and resume

- [x] 9.1 Define the complete `state.json` schema with TS types + validator
- [x] 9.2 Write `state.json` after each significant state change
- [x] 9.3 Heartbeat: timer that updates `lastHeartbeat` every N seconds during agent invocations
- [x] 9.4 When opening `/loop` on a project, scan `<project>/.loop/runs/` for runs with `status: "running"` and old heartbeat (> N×3 seconds)
- [x] 9.5 "interrupted run detected · resume?" banner with resume / archive buttons
- [x] 9.6 On resume: discard partial outputs (file without final `<agent>.diff`), relaunch from the last incomplete agent
- [ ] 9.7 Manual test: kill the process mid-run, reopen, confirm it resumes without losing completed phases

## 10. Polish and edge cases

- [x] 10.1 Toast/notifications for key events: run completed, phase with warning, budget exceeded, conflict detected
- [x] 10.2 Confirmation when abandoning a run mid-way (risk of losing unsaved state)
- [x] 10.3 Keyboard shortcuts: Cmd+Enter to send a message in Step 1, Cmd+S in editors
- [x] 10.4 Empty states: no profiles, no previous runs, abandoned run
- [x] 10.5 Log CLI invocations to a file (future debugging) — optional but useful
- [x] 10.6 Review basic accessibility of new focus rings and aria-labels
- [x] 10.7 Document in `README.md` that `claude`, `codex`, `opencode` must be installed to use `/loop`

## 11. Final validation

- [ ] 11.1 End-to-end smoke run: small project, 3 phases, sequential mode, claude for everything
- [ ] 11.2 Multi-CLI run: analysis claude, impl opencode, reviewer codex — confirms the file-based contract works
- [ ] 11.3 Hybrid run with 5 phases in 2 batches, confirm the integrator detects the correct batch and propagates knowledge
- [ ] 11.4 Reviewer cap test: force a case where the reviewer asks for retry 3 times in a row, verify warning propagated
- [ ] 11.5 Resume test: kill app mid-way, reopen, resume
- [ ] 11.6 Profile validation test: configure slot with uninstalled CLI, see red marking, see run disabled
- [ ] 11.7 Prompt-to-global promotion test: edit inline, "save as global default", verify file in `<app-config>/prompts/`
