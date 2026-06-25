## ADDED Requirements

### Requirement: Active project required to open /loop
The `/loop` window SHALL block entry if there is no active project in the workspace. The user MUST select a project before starting a new run.

#### Scenario: No active project
- **WHEN** the user opens `/loop` and `activeProjectId` is `null`
- **THEN** the window shows "pick a project first" and disables the Step 1 input
- **AND** the choose-project button leads to the workspace

#### Scenario: Project with invalid path
- **WHEN** the active project has `pathInvalid: true`
- **THEN** `/loop` shows the path validation error and does not allow starting a run

### Requirement: Multi-turn chat with configurable CLI
Step 1 SHALL allow a multi-turn conversation with one of the available CLIs (claude, codex, opencode) to refine the user's problem until consolidating `01-problem.md`. Each turn MUST be invoked in one-shot mode (`-p` / `exec` / `run`) serializing the previous conversation into the prompt — there is no persistent CLI session.

#### Scenario: User starts conversation
- **WHEN** the user types a problem in the input and presses "Send"
- **THEN** the system invokes the selected CLI passing a system prompt (`problem-intake.md`) + the user's message
- **AND** the CLI response is rendered as the assistant's message in the chat

#### Scenario: Next turn with serialized history
- **WHEN** the user replies to the assistant
- **THEN** the system invokes the CLI again passing the entire previous conversation (turns 1..N-1) as context in the prompt
- **AND** the CLI output is added to the chat

#### Scenario: User switches CLI mid-conversation
- **WHEN** the user selects another CLI from the chip selector
- **THEN** the next turns use the new CLI
- **AND** the previous conversation is preserved (the history is the contract, not the CLI)

### Requirement: Editing the problem-intake system prompt
The user SHALL be able to edit the `problem-intake.md` system prompt from the Step 3 setup (unified view). Temporary changes apply to the current run; "↓ save as global default" persists to `<app-config>/prompts/problem-intake.md`.

#### Scenario: Temporary prompt edit
- **WHEN** the user edits the Step 1 prompt in the inline editor and returns to the chat without saving as global
- **THEN** the next turns use the edited prompt
- **AND** the global does not change

### Requirement: Consolidation to 01-problem.md
Step 1 SHALL expose a "consolidate" button that, when pressed, invokes the CLI one last time to produce `01-problem.md` with the summary of the agreed problem. That file SHALL be persisted at `<project>/.loop/runs/<run-id>/01-problem.md` and unblock Step 2.

#### Scenario: Successful consolidation
- **WHEN** the user presses "consolidate" with at least one conversation turn
- **THEN** the CLI is invoked with a closing prompt asking it to produce a structured markdown
- **AND** the output is written to `01-problem.md` of the run
- **AND** the UI navigates to Step 2

#### Scenario: Consolidation without conversation
- **WHEN** the user presses "consolidate" without having had any turns
- **THEN** the button is disabled and shows "add at least one message first"
