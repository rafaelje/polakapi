# multiterm

Desktop app built with Tauri for working with multiple local terminal panes in one window.

## Stack

- Tauri 2 for the desktop shell and native commands.
- Rust + `portable-pty` for PTY lifecycle and terminal I/O.
- Vite + TypeScript for the frontend.
- xterm.js for terminal rendering.
- `@tauri-apps/plugin-store` for persisted layout and notes state.

## Requirements

- Node.js 22.
- pnpm 11.8.0.
- Rust stable with `rustfmt` and `clippy`.
- Linux builds also need the Tauri/WebKit system packages installed in `.github/workflows/ci.yml`.

## Development

```sh
pnpm install
pnpm tauri dev
```

Useful checks:

```sh
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run rs:fmt:check
pnpm run rs:clippy
pnpm run rs:test
pnpm run check
```

## Project Structure

```text
src/
  main.ts                 Minimal Vite entrypoint.
  app/                    App bootstrap, DOM elements, lifecycle, and orchestration.
  modules/
    terminal/             xterm pane UI, terminal manager, and Tauri PTY client API.
    layout/               Resize gutters, panel toggles, and layout types.
    notes/                Notes panel and notes persistence wiring.
  shared/
    tauri/                Tauri invoke wrapper.
    ui/                   Toasts and modal primitives.
    persistence/          Store-backed layout persistence.
    keyboard/             Keyboard shortcut wiring.
    dom/                  DOM lookup helpers.
  shared/                 Cross-feature helpers such as invoke, persistence, shortcuts, and toasts.
src-tauri/
  src/
    commands.rs           Tauri commands exposed to the frontend.
    pty.rs                PTY creation, session registry, events, and cleanup.
    lib.rs                Tauri builder, plugins, state, and app lifecycle.
```

## Architecture Notes

- Rust owns PTY processes and emits `pty:data` / `pty:exit` events to the frontend.
- The frontend sends writes, resizes, and kills through typed wrappers in `src/modules/terminal/pty-client.ts`.
- PTY sessions are cleaned up from Rust when the main window closes and again when the store is dropped.
- Layout and notes are persisted through the Tauri store plugin.
- Tauri capabilities should stay minimal. Add permissions only when a feature needs them.

## Quality Bar

`pnpm run check` is the local gate before opening a PR. It runs frontend typecheck, lint, formatting, existing unit tests, Rust formatting, clippy, and Rust tests.
