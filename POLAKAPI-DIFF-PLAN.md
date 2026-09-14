# /diff — plan

A native diff reviewer for polakapi: the changed-file list for a project, the edited
lines, and an agent panel on the left to ask questions or have the agent edit the file
directly. Keyboard-driven, with the staging actions lazygit gives you.

Status: plan only. No code written yet.

## 1. What it does

Two comparison modes, switchable from a picker in the header:

- **Working tree** (default) — staged, unstaged and untracked changes, the way `lazygit`
  opens. This is the mode where staging and discarding make sense.
- **Branch** — `HEAD` vs a base ref you pick (defaults to the detected base:
  `origin/HEAD` → `main` → `master`). Read-only: no staging, no discarding.

Layout, three columns:

```
┌──────────────────┬─────────────────────┬────────────────────────────────┐
│ agent panel      │ file list           │ patch view                     │
│                  │                     │                                │
│ cli + model      │ ● staged            │ @@ -12,7 +12,9 @@              │
│ transcript       │   M src/app.ts      │ -  const x = 1                 │
│ prompt box       │ ● unstaged          │ +  const x = 2                 │
│                  │   M src/diff.ts     │ +  const y = 3                 │
│ [ask] [apply]    │ ● untracked         │                                │
│                  │   ? notes.md        │                                │
└──────────────────┴─────────────────────┴────────────────────────────────┘
```

The agent panel goes on the left as requested. The file list is the navigation spine; the
patch view follows the selection.

## 2. Why a separate window

`/diff` becomes its own Tauri window, like `/adversarial review`, `/loop` and `/sessions`.
Three columns plus a transcript do not fit the main window's sidebar modals, and the
existing window pattern is already proven here:

- `adversarial.html` at the repo root, registered in `vite.config.ts`
  (`build.rollupOptions.input`).
- An opener module following `src/modules/agents-flow/adversarial-window.ts`: one window
  per label, a second click refocuses the existing instance instead of spawning another.
- A `/diff` button in the `index.html` sidebar next to `/agents`, `/skills`, `/memory`.

## 3. Backend

New module `src-tauri/src/git_diff.rs`, registered in `lib.rs`.

It reuses what `git_review` already has rather than duplicating it — `validate_repo_path`,
`is_safe_git_ref`, `merge_base`, `origin_head`, `ref_exists`, `rev_parse_verify` and
`current_branch` live in `src-tauri/src/git_review/repository.rs`. Some are `pub(super)`
today and need widening to `pub(crate)`, the same way `validate_repo_path` was already
widened for `git_worktree`.

### Commands

| Command | Purpose |
| --- | --- |
| `diff_overview(project_path, base_ref?)` | The changed-file list. Working tree when `base_ref` is absent, branch diff against the merge base otherwise. |
| `diff_file_patch(project_path, path, source, base_ref?)` | Unified diff for one file. `source` ∈ `staged` \| `unstaged` \| `untracked` \| `branch`. |
| `diff_refs(project_path)` | Local and remote refs for the base picker. |
| `diff_stage(project_path, paths)` | `git add -- <paths>` |
| `diff_unstage(project_path, paths)` | `git restore --staged -- <paths>` |
| `diff_discard(project_path, paths)` | `git restore --staged --worktree -- <paths>`; untracked files are deleted. |

### Shapes

```rust
pub struct DiffFile {
    path: String,
    old_path: Option<String>,   // rename source
    status: String,             // modified | added | deleted | renamed | untracked | conflicted
    staged: bool,
    unstaged: bool,             // a file can be both — partially staged
    untracked: bool,
    insertions: u32,
    deletions: u32,
    binary: bool,
}

pub struct DiffOverview {
    head_branch: String,
    base_ref: Option<String>,   // None => working tree mode
    files: Vec<DiffFile>,
}
```

### How the list is built

Working tree mode, three reads combined by path:

- `git status --porcelain -z --untracked-files=all` — the `XY` codes give staged (`X`) and
  unstaged (`Y`) state per path, including renames and conflicts. `-z` so filenames with
  spaces or newlines survive.
- `git diff --numstat -z` — unstaged insertion/deletion counts.
- `git diff --cached --numstat -z` — staged counts.

Branch mode: resolve the merge base, then `git diff --numstat -z <base>...HEAD` plus
`--name-status -z` for the status letters.

### Safety

This is the first module in the app that *writes* to a repo through git, so the posture
matters more than it does for `git_review`:

- Every path is validated before it reaches a command: non-empty, not absolute, no leading
  `-`, no `..` component, length-capped. Always passed after a `--` separator so nothing
  can be read as a flag.
- `base_ref` keeps going through `is_safe_git_ref` then `git rev-parse --verify`, the rule
  `git_review` already follows.
- `diff_discard` is destructive and irreversible — discarded working-tree changes are not
  in any reflog. It gets a two-step confirm in the UI, the same pattern as the `/memory`
  delete button, and the plan is to never wire it to a bare keypress without the confirm.
- Branch mode is read-only. Staging actions are disabled there, not just hidden.

## 4. Frontend

```
diff.html                        window entry
src/modules/diff/
  diff.ts                        bootstrap, mirrors adversarial.ts
  diff-chrome.ts                 layout + wiring
  diff-router.ts                 active project from the workspaces store
  diff-service.ts                invoke wrappers
  types.ts
  file-list.ts                   grouped list, selection, staging actions
  patch-view.ts                  hunk and line rendering
  agent-panel.ts                 cli/model picker, transcript, prompt box
src/styles/diff.css
```

### File list

Grouped into staged / unstaged / untracked sections with counts, the active project's
files only. Keyboard first, following lazygit where the mapping is obvious:

| Key | Action |
| --- | --- |
| `↑` `↓` / `j` `k` | move selection |
| `space` | stage / unstage the selected file |
| `a` | stage everything |
| `d` | discard — armed, needs a second press |
| `r` | refresh |
| `⏎` | focus the patch view |
| `esc` | close the window |

### Patch view

Parses the unified diff into hunks and renders each line classed by origin (context,
addition, deletion, hunk header) with old/new line numbers in a gutter. No syntax
highlighting in v1 — line-level colouring only, which is what makes a diff readable.

Binary and very large files get a placeholder instead of a body, with the same per-file
byte cap idea `git_review` already uses (`MAX_FILE_BYTES`) so one lockfile cannot freeze
the view.

## 5. Agent panel

This is the part that needs the most care, because "ask the agent" and "ask it in the
session I already have running" are two different problems.

### Phase 1 — its own session (this branch)

Reuses `run_loop_agent` from `src-tauri/src/loop_cli.rs`. That command already does
everything needed: picks the CLI (`claude` / `codex` / `opencode`), takes a `cwd`, a
`user_input`, a `timeout_secs`, and — critically — a `session_id`, returning the session id
it used in `AgentResult`.

So the panel is a real multi-turn conversation, not a chain of one-shots: hold the
`session_id` from the first reply and pass it back on every later turn.
`invoke_claude` maps it to `--resume`, `opencode` to `--session`, `codex` to its own resume
flag. The system prompt is only sent on the first turn; resumes inherit it.

The agent runs with `cwd` set to the project root, so when you ask it to change something
it edits the real file and the change shows up in the file list on the next refresh. That
covers "modificar algo directamente en el archivo" without a separate apply mechanism.

Context sent on the first turn: the selected file's path and its patch. A "send whole
diff" toggle for questions that span files.

One blocker to resolve: `run_loop_agent` validates the run directory root through
`is_allowed_run_dir_root`, which today only accepts `.loop` and `.adversarial`
(`src-tauri/src/loop_cli/scope.rs`). `/diff` needs its own root added there — likely
`.polakapi-diff` — or the command needs a path that skips the run-dir requirement
entirely, since `/diff` has no run artifacts to write.

### Phase 2 — the session already running in a polakapi terminal (deferred)

What was asked for as "luego vemos": attach to the CLI session of a terminal already open
in polakapi instead of starting a fresh one.

The lead worth investigating is `src-tauri/src/agent_sessions.rs`, plus the capture hooks
that already record session ids per PTY (`POLAKAPI_PTY_ID`, the `notification_events`
plumbing). If a terminal's live CLI session id is recoverable from there, the panel could
offer "continue in <terminal name>'s session" and pass that id straight into
`run_loop_agent`.

Not designed yet. It is listed here so phase 1 does not paint us into a corner: the panel
should treat the session id as an input it may be *given*, not only one it creates.

## 6. Tests

- Rust: `git status --porcelain -z` parsing including renames, conflicts and quoted
  filenames; numstat merging; path validation rejecting absolute paths, `..` and leading
  `-`; branch-mode merge-base resolution. Fixtures built with real `git init` temp repos,
  the way `git_review/tests.rs` and `git_worktree/tests.rs` already do it.
- Frontend: unified-diff parsing into hunks and line kinds; file-list grouping and counts;
  the keyboard map; the two-step discard arming.

## 7. Order of work

1. `git_diff.rs` read-only: `diff_overview`, `diff_file_patch`, `diff_refs`, with tests.
2. Window shell: `diff.html`, vite input, opener, sidebar button, three-column layout.
3. File list + patch view against the read-only commands.
4. Staging actions: `diff_stage`, `diff_unstage`, then `diff_discard` with its confirm.
5. Agent panel phase 1, including the `is_allowed_run_dir_root` change.
6. Version bump per `AGENTS.md` — `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` all aligned and above the PR base.

## 8. Notes and risks

- **Branch interaction.** This branch is cut from `main`. `run_one_shot`, the small
  one-shot helper `/skills` uses, exists only on `skill-and-memory-reviewers` and is not
  available here. If that branch lands first, some of this can lean on it; if not, the
  agent panel goes straight to `run_loop_agent`.
- **`diff_discard` is the one genuinely dangerous action in the feature.** Worth deciding
  explicitly whether it ships in the first PR or waits until the rest is settled.
- **Partially staged files** are real and common — a file can be in both the staged and
  unstaged sections at once. The list has to show it twice rather than pick one, or the
  staging state becomes a lie.
- Large repos: `diff_overview` runs three git processes per refresh. Fine interactively,
  but the refresh should be debounced rather than bound to every window focus event.
