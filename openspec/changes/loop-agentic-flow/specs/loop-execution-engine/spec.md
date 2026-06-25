## ADDED Requirements

### Requirement: Execution mode selection
Step 3 SHALL offer two modes: **sequential** (one phase at a time with propagated knowledge) and **hybrid** (batches via topological sort with an integrator between each one). The mode MUST be selected before starting the run.

#### Scenario: Hybrid mode unavailable
- **WHEN** all phases depend linearly on each other (topological sort produces N batches of 1)
- **THEN** the selector allows choosing hybrid but the UI warns "equivalent to sequential · no parallelism"

### Requirement: Agent pipeline in sequential mode
In sequential mode, for each phase the system SHALL execute agents in this order: **analysis → implementation → reviewer → knowledge**. Each agent MUST wait for the previous agent's output. The next phase SHALL receive the previous phase's `knowledge.md` as additional input.

#### Scenario: Phase approved on first attempt
- **WHEN** the reviewer returns `ok` on the first attempt
- **THEN** the knowledge agent runs with all outputs (analysis + implementation + review)
- **AND** the system advances to the next phase with the produced `knowledge.md`

### Requirement: Reviewer retry cap
The reviewer SHALL approve or request retry. If it returns `retry+feedback`, the system MUST relaunch the implementation with the attached feedback. The cap is **3 attempts**. When 3 are reached without approval, the phase MUST be marked with state `warning` (⚠) and the system SHALL continue to the knowledge agent with the last attempt.

#### Scenario: Approved on attempt 2
- **WHEN** the reviewer asks for retry on attempt 1 and approves on attempt 2
- **THEN** the phase ends in state `done` (no warning)
- **AND** the retry counter is persisted in `state.json`

#### Scenario: Cap reached
- **WHEN** the reviewer asks for retry on all 3 attempts
- **THEN** the phase ends in state `warning`
- **AND** the knowledge agent runs anyway with the last implementation output
- **AND** the `knowledge.md` MUST explicitly mention the debt in the "Warnings" section

### Requirement: Hybrid mode by batches
In hybrid mode, the system SHALL group phases into batches via topological sort (phases with no pending dependencies run in parallel). Within a batch, the phases SHALL run their agent pipelines (analysis → impl → reviewer → knowledge) without sharing knowledge between them. Between batches, an integrator agent MUST consolidate the individual knowledge and validate that there are no FS conflicts.

#### Scenario: Two batches with integrator between
- **WHEN** the topological sort produces batch 1 = [01, 04] and batch 2 = [02, 03, 05] depending on [01, 04]
- **THEN** the system runs the pipelines of 01 and 04 in parallel
- **AND** when both finish, executes the batch 1 integrator
- **AND** the integrator produces a consolidated `knowledge.md` at `outputs/batches/batch-1/knowledge.md`
- **AND** that consolidated file is passed as additional input to phases 02, 03, 05

#### Scenario: FS conflict detected by the integrator
- **WHEN** two phases of the same batch touched the same file with incompatible changes
- **THEN** the integrator reports the conflict in its output
- **AND** the run pauses waiting for the user's decision (continue / abort / re-execute phase)

#### Scenario: Phase ⚠ in batch propagates warning
- **WHEN** phase 04 ends in warning state within batch 1
- **THEN** the batch 1 integrator records it in the consolidated knowledge
- **AND** the phases of batch 2 receive that knowledge with the note of the debt

### Requirement: Agent invocation via configured CLI
Each agent SHALL be executed by invoking the configured CLI (claude/codex/opencode) with its corresponding model via the `run_loop_agent` Tauri command. The invocation MUST be one-shot and return a normalized `AgentResult` with `text`, `tokens_in`, `tokens_out`, `cost_usd`, `session_id`, and `error`. Each invocation MUST respect a configurable timeout (default 300s).

#### Scenario: Successful claude invocation
- **WHEN** the analysis agent is configured as `claude / opus-4-7`
- **THEN** the system invokes `claude -p <prompt> --model opus-4-7 --output-format json --append-system-prompt-file <prompts/analysis.md>`
- **AND** parses the resulting JSON and normalizes it to `AgentResult`

#### Scenario: Invocation timeout
- **WHEN** an agent invocation exceeds the configured timeout
- **THEN** the subprocess is killed
- **AND** the agent reports `error: "timeout"` and the phase enters retry flow (if applicable)

#### Scenario: CLI not available in PATH
- **WHEN** the configured CLI is not executable
- **THEN** the invocation fails fast with error "cli not found"
- **AND** the user is notified before spending tokens on subsequent agents

### Requirement: State persistence and resume
Each run SHALL persist its state in `<run>/state.json` with per-agent granularity, including the current batch (hybrid mode), the current agent per phase, the retry counter, and a `lastHeartbeat`. When opening `/loop` on a project that has a run with `status: "running"` and old heartbeat, the system MUST detect it and offer to resume.

#### Scenario: Resume after crash
- **WHEN** the app crashes during a run and the user reopens `/loop` on the same project
- **THEN** the system reads `state.json` and shows "interrupted run detected · resume?"
- **AND** on confirm, the scheduler resumes from the last incomplete task
- **AND** if an agent was halfway (partial output), its work is discarded and relaunched from scratch

#### Scenario: Heartbeat updated
- **WHEN** an agent is running
- **THEN** the run updates `lastHeartbeat` in `state.json` every N seconds
- **AND** if more than N×3 seconds pass without an update, a crash is assumed

### Requirement: Budget visible live
The execution view SHALL show the accumulated USD cost and consumed tokens, broken down per agent. When the run exceeds the configured budget, the system MUST pause before the next invocation and ask for confirmation.

#### Scenario: Budget exceeded
- **WHEN** the accumulated cost exceeds the run's configured budget
- **THEN** the scheduler pauses before the next agent
- **AND** shows "budget exceeded · continue / abort"
