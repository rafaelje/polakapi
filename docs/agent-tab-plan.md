# agent tab — operator agent for polakapi

The bottom panel's **agent** tab runs any installed AI CLI (claude, codex,
cursor-agent, gemini, opencode) with a set of MCP tools that act on the running
polakapi: list and reorganize workspaces and projects, select a project, create
worktrees as projects, open terminals and send text to them, read what a pane
shows, inspect live agents' context, read skills and memory files, start and
poll adversarial reviews, and switch context mode.

## 1. Moving parts

```
agent tab (main webview)           CLI process (child of a PTY)
  agent-panel.ts                     claude / codex / cursor-agent / gemini / opencode
    ↓ agent_home_prepare(cli)            ↓ spawns the registered MCP server
  <app_data>/agent-home/             polakapi app-mcp --control <file>
    AGENTS.md CLAUDE.md GEMINI.md      app_control/mcp.rs  (stdio JSON-RPC)
    mcp/claude.json, .cursor/mcp.json,   ↓ one JSON line per request
    .gemini/settings.json, opencode.json  app_control/client.rs
                                            ↓ 127.0.0.1:<port> + token
control server (Rust, in the app)        app_control/server.rs
  emit "app-control:request" → main webview
                                            ↓
control bridge (main webview)            control-bridge.ts
  tools.list / tools.call → tools/registry.ts → tools/*.ts
  app_control_respond(id, ok, payload) → back down the same line
```

- **One binary.** `main.rs` dispatches `app-mcp` before Tauri boots, like
  `ctx-mcp` and `capture`. `mcp_stdio.rs` holds the shared JSON-RPC loop.
- **The tools live in TypeScript**, next to the controller and router they
  act on. The Rust MCP server is a relay: it asks the app for the catalog on
  `tools/list` and forwards every `tools/call`. Tool failures come back as
  `isError` content so the model can read the reason and retry.
- **Loopback TCP with a per-launch token.** The app binds `127.0.0.1:0` at
  startup and writes `<app_data>/agent-control-<pid>.json` (`port`, `token`,
  `pid`, `exe`, mode 0600). The file is per instance: a dev build running next
  to the installed one, or an accidental second launch, cannot hijack the
  servers the first instance registered. Each agent launch points its MCP
  config at the file of the instance that launched it; the file is removed
  when the main window closes, and files of dead instances are swept at
  startup. The MCP process re-reads the file on every call and reports the
  instance as gone when it is missing or not answering. TCP rather than a Unix
  socket keeps Windows on the same code path.
- **Single instance in release builds.** `tauri-plugin-single-instance`
  focuses the running window when the installed app is launched again. Debug
  builds skip it so a dev build can run next to the installed one.
- **Agent home.** The CLI runs in `<app_data>/agent-home/`, not in a project.
  Each launch rewrites the MCP registration for that CLI with the current
  binary path and the instructions (`AGENTS.md`, mirrored as `CLAUDE.md` and
  `GEMINI.md`). Projects are passed to tools as ids, names or paths.

## 2. Per-CLI launch

| CLI | Registration | Extra args |
| --- | --- | --- |
| claude | `mcp/claude.json` | `--mcp-config <file> --strict-mcp-config --allowedTools mcp__polakapi` |
| codex | `-c mcp_servers.polakapi.command=… -c mcp_servers.polakapi.args=[…]` | none |
| cursor-agent | `.cursor/mcp.json` | `--approve-mcps --trust` |
| gemini | `.gemini/settings.json` with `trust: true` | `--allowed-mcp-server-names polakapi` |
| opencode | `opencode.json` (`mcp.polakapi`, type local) | none |

The polakapi tools are pre-approved (the user chose that); the CLIs' own shell
and file tools keep their normal approval flow. Destructive operations (delete
project or workspace, kill a terminal) are deliberately not exposed in v1.

Verified end to end on Linux: Claude Code in print mode called
`polakapi_overview` and `polakapi_project_status` through the generated config
and reported the live state. cursor-agent reached the model with `--trust`
(the account was out of quota). gemini needs an interactive login first.

## 3. Tool catalog (28)

- Workspaces: `polakapi_overview`, `polakapi_select_project`,
  `polakapi_create_workspace`, `polakapi_add_project`,
  `polakapi_create_worktree`, `polakapi_move_project`,
  `polakapi_reorder_projects`, `polakapi_rename_project`.
- Terminals: `polakapi_project_status`, `polakapi_agents_status`,
  `polakapi_open_terminal`, `polakapi_send_to_terminal`,
  `polakapi_read_terminal`, `polakapi_suspend_project`,
  `polakapi_resume_project`.
- Libraries and context: `polakapi_skills_list`, `polakapi_skill_read`,
  `polakapi_memory_list`, `polakapi_memory_read`, `polakapi_agent_context`,
  `polakapi_agent_context_search`, `polakapi_agent_context_entry`.
- Adversarial review: `polakapi_adversarial_start`,
  `polakapi_adversarial_status`, `polakapi_adversarial_findings`,
  `polakapi_adversarial_abort`. Runs use the same scheduler and run directory
  as the window (`adversarial-runner.ts`), so the window can open them later.
- Context mode: `polakapi_context_mode_status`, `polakapi_context_mode_set`.

## 4. Files

- Rust: `src-tauri/src/app_control.rs` (+ `server.rs`, `client.rs`, `mcp.rs`,
  `home.rs`, `detect.rs`), `src-tauri/src/mcp_stdio.rs`,
  `src-tauri/resources/agent-home/AGENTS.md`.
- TypeScript: `src/modules/app-agent/` (`agent-panel.ts`,
  `control-bridge.ts`, `adversarial-runner.ts`, `tools/*`),
  `src/styles/agent-panel.css`.
- Touched: bottom panel (new tab), `cli-registry.ts` (gemini profile),
  `pty_activity.rs` (gemini in the AI CLI allowlist), `TerminalPane.readScreen`,
  `WorkspacesController.createWorkspace`, `layout.json` (`agentCli`).

## 5. Not in v1

- Deleting projects, workspaces or terminals through tools.
- Streaming tool results (every call returns when it is done; adversarial
  reviews are polled).
- Project windows: the bridge lives in the main window only, which is also
  where the workspaces state lives.

## 6. Telegram

The same tools can be reached from a Telegram bot that runs headless turns of
the operator agent. It lives in `src-tauri/src/app_control/telegram/`.
