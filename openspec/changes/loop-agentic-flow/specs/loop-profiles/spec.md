## ADDED Requirements

### Requirement: Global profile storage in JSON
Profiles SHALL be persisted in `profiles.json` in the app's config dir (via `tauri-plugin-store`), following the same pattern as `workspaces.json`. The file MUST have `schemaVersion` and a `profiles[]` array. Each profile contains `id`, `name`, `createdAt`, and a `matrix` with the 5 agents (`analysis`, `implementation`, `review`, `knowledge`, `integration`), each with `{ cli, model }`.

#### Scenario: First load with no profiles
- **WHEN** the app opens for the first time and `profiles.json` does not exist
- **THEN** the system creates one with `{ schemaVersion: 1, profiles: [] }`
- **AND** the UI shows "no saved profiles"

#### Scenario: Incompatible schema version
- **WHEN** `profiles.json` exists with an unknown `schemaVersion`
- **THEN** the system treats it as empty (silent fallback, same as `workspaces-store.ts`)
- **AND** preserves the original file without overwriting

### Requirement: Default with no profile loaded
When no profile is loaded in the Step 3 setup, all matrix slots SHALL start with `claude / opus-4-7`. The user can edit each slot manually from that point.

#### Scenario: Initial setup without profile
- **WHEN** the user lands on the Step 3 setup and does not select a profile from the dropdown
- **THEN** the 5 agents show `claude / opus-4-7`
- **AND** the badge of each slot indicates "default" (not "modified")

### Requirement: Temporary overrides on loaded profile
When the user loads a profile and modifies any slot, the changes SHALL apply only to the current run. To persist, the system MUST expose explicit buttons: "save" (overwrites the loaded profile) or "save as…" (creates a new one).

#### Scenario: Override applies to the run without persisting
- **WHEN** the user loads the "my mixed" profile and changes the reviewer from codex to claude/sonnet
- **AND** clicks "execute run" without touching "save"
- **THEN** the run uses claude/sonnet for the reviewer
- **AND** "my mixed" in `profiles.json` remains with codex

#### Scenario: Save as new
- **WHEN** the user with a loaded profile modifies slots and chooses "save as…"
- **THEN** a name is requested and a new profile is created in `profiles.json`
- **AND** the original profile does not change

### Requirement: Availability validation on load
On loading a profile, the system SHALL validate that each CLI is installed (in PATH) and that the configured model is available. If any fails, the corresponding slot MUST be marked red in the UI, without suggesting automatic fallbacks. The user MUST manually choose another CLI/model before being able to execute the run.

#### Scenario: CLI not installed
- **WHEN** a profile is loaded whose analysis agent is configured with `opencode` and `opencode` is not in PATH
- **THEN** the analysis agent slot is marked red with text "opencode not found"
- **AND** the "execute run" button is disabled until the user corrects it

#### Scenario: Nonexistent model
- **WHEN** a profile references a deprecated model (e.g. `haiku-4-5` in claude 2.1.187 that returns 404)
- **THEN** the system marks the slot red with "model not available"
- **AND** the user manually chooses another model from the dropdown
