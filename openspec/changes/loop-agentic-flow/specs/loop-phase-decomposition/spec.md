## ADDED Requirements

### Requirement: Initial phase generation from 01-problem.md
Step 2 SHALL invoke the configured CLI (with the system prompt `phase-decomposition.md`) passing `01-problem.md` to produce a list of phases. Each phase MUST have a sequential identifier (`01`, `02`, ...), a name, and at least a `logic.md` file. The LLM SHALL decide whether the phase additionally includes `visual.html`.

#### Scenario: Successful generation
- **WHEN** the user consolidates Step 1 and enters Step 2 for the first time
- **THEN** the system invokes the CLI with `01-problem.md` as input
- **AND** creates one folder per phase in `<run>/phases/<NN>-<slug>/`
- **AND** each folder contains `logic.md` (always) and `visual.html` (when the LLM marked it as needed)

#### Scenario: Phase without visual part
- **WHEN** the LLM determines that a phase has no visual component (e.g. pure backend task)
- **THEN** that phase's folder only contains `logic.md`
- **AND** the UI does not show the `visual.html` tab for that phase

### Requirement: Dependency declaration between phases
Each phase SHALL have a `dependsOn: [phaseId]` field. The LLM proposes initial values; the user SHALL be able to edit them. A phase with `dependsOn: []` is a root. The system MUST detect cycles and reject them.

#### Scenario: LLM proposes dependencies
- **WHEN** the LLM generates the initial phases
- **THEN** each phase comes with a proposed `dependsOn[]`
- **AND** the sidebar shows "↳ root" or "↳ depends on <pill>NN</pill>" below the name

#### Scenario: User edits dependencies
- **WHEN** the user opens a phase's editor and modifies `dependsOn`
- **THEN** the topology view is recalculated instantly
- **AND** the batches in hybrid mode are reordered according to the new DAG

#### Scenario: Cycle detected
- **WHEN** the user tries to add a dependency that would create a cycle (e.g. 02 depends on 04 and 04 depends on 02)
- **THEN** the system rejects the change and shows "cycle detected between 02 and 04"

### Requirement: Inline editor with phase sidebar
Step 2 SHALL expose an editor with a phase sidebar on the left and `logic.md` / `visual.html` tabs on the right. The user MUST be able to add, remove, rename, and reorder phases manually.

#### Scenario: Add phase manually
- **WHEN** the user presses "+ add phase" in the sidebar
- **THEN** a new phase is created with a placeholder name and empty `logic.md`
- **AND** it is selected for editing

#### Scenario: Delete phase with dependents
- **WHEN** the user deletes a phase X and there is a phase Y with `X` in its `dependsOn`
- **THEN** the system asks for confirmation
- **AND** on confirm, removes `X` from the `dependsOn` of all dependent phases

### Requirement: AI-assisted editing
Each file (`logic.md` or `visual.html`) SHALL expose an "edit with AI" button that opens a mini-chat over the current selection and replaces that section with the proposed edit when the user accepts.

#### Scenario: Successful edit with AI
- **WHEN** the user selects text in `logic.md` and presses "✨ edit with AI" with an instruction ("make it more concise")
- **THEN** the system invokes the CLI with the selected section and the instruction
- **AND** shows the proposed diff
- **AND** on accept, replaces the section with the edit

### Requirement: Topology view derived from the DAG
Step 2 SHALL include a read-only "execution topology" view that shows the batches computed from the `dependsOn` of all phases. The view MUST be recalculated instantly when dependencies change.

#### Scenario: Topology with two batches
- **WHEN** the phases are 5 (01 root, 04 root, 02 depends on 01, 03 depends on 01, 05 depends on 04)
- **THEN** the view shows batch 1 = [01, 04], batch 2 = [02, 03, 05]
- **AND** the summary indicates "2 parallel batches · parallel mode possible"

#### Scenario: Fully linear topology
- **WHEN** each phase depends on the previous one
- **THEN** the view shows N batches with one phase each
- **AND** the summary indicates "parallel mode does not apply — equivalent to sequential"
