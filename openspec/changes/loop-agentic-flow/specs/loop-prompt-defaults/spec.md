## ADDED Requirements

### Requirement: Set of 7 editable global prompts
The app SHALL maintain 7 user-editable default prompts, stored in `<app-config>/prompts/`:

1. `problem-intake.md` — Step 1 system prompt (refinement chat)
2. `phase-decomposition.md` — Step 2 system prompt (phase generation + dependsOn + visual yes/no decision)
3. `analysis.md` — Step 3 analysis agent
4. `implementation.md` — Step 3 implementation agent
5. `review.md` — Step 3 reviewer agent
6. `knowledge.md` — Step 3 knowledge agent
7. `integration.md` — hybrid mode integrator agent

#### Scenario: First installation
- **WHEN** the app opens for the first time and `<app-config>/prompts/` does not exist
- **THEN** the system creates the directory
- **AND** copies the 7 files bundled with the app as initial seeds

#### Scenario: Recovery of a deleted file
- **WHEN** the user manually deletes one of the default files (e.g. `analysis.md`)
- **AND** the app starts
- **THEN** the system detects the missing file and restores the bundled seed
- **AND** notifies "the default analysis prompt was restored"

### Requirement: Atomic copy on run creation
When creating a new run, the system SHALL atomically copy the 7 global prompts to `<run>/prompts/`. That copy is the run's contract — future edits to the globals do NOT affect already created runs, and edits to the run copy do not propagate to the globals.

#### Scenario: Run creation with current global prompts
- **WHEN** the user starts a new run from Step 1
- **THEN** the system creates `<run>/prompts/` and copies the 7 global files inside
- **AND** all run invocations pass the run's prompts, not the globals

#### Scenario: Global edit during active run
- **WHEN** a run is running and the user edits the global `analysis.md`
- **THEN** the in-progress run is not affected (continues using its copy)
- **AND** a new run created after the edit does inherit the updated global

### Requirement: Inline editing from the Step 3 setup
The Step 3 setup SHALL expose a unified view with a sidebar of the 7 prompts and an editor in the main panel. Each prompt MUST be editable inline for the run, and the panel MUST expose two buttons per prompt: **"↑ reset to global"** (replaces the run's with the current global) and **"↓ save as global default"** (overwrites the global with the run's).

#### Scenario: Temporary edit for the run
- **WHEN** the user selects "analysis" in the sidebar and edits the textarea
- **AND** clicks "execute run" without touching the sync buttons
- **THEN** the run uses the edited prompt
- **AND** the global `analysis.md` does not change
- **AND** the sidebar shows the "modified" badge in that row

#### Scenario: Promote edit to global
- **WHEN** the user edits a prompt and clicks "↓ save as global default"
- **THEN** the corresponding global file at `<app-config>/prompts/` is overwritten with the run's content
- **AND** the badge changes from "modified" to "default"

#### Scenario: Reset to global
- **WHEN** the user clicks "↑ reset to global" on a modified prompt
- **THEN** the run's prompt is replaced with the current global content
- **AND** the badge changes from "modified" to "default"

### Requirement: Visual indicator of divergence vs global
The setup's prompt sidebar SHALL show, per prompt, a **"default"** badge (identical to the current global) or **"modified"** (diverges from the global). The badge MUST be recalculated each time the user edits the prompt or syncs with the global.

#### Scenario: Initial state at run creation
- **WHEN** the user creates a new run and opens the Step 3 setup
- **THEN** the 7 prompts show the "default" badge (because they were just copied from the global)
