# telegram bot — talk to the operator agent from Telegram

Let the operator agent (the bottom panel's **agent** tab, see
`agent-tab-plan.md`) receive messages from a Telegram bot and answer in the
same chat, the way Hermes' gateway does: a long-polling bot in front of an
agent loop, restricted to an allowlist of Telegram users.

## 1. Goals and non-goals

Goals:

- A Telegram user on the allowlist sends a message; the operator agent runs a
  turn with the 28 polakapi MCP tools and the final answer comes back to the
  chat.
- Conversation continuity per chat (follow-ups remember the previous turns).
- Configurable from the settings window: bot token, allowed user ids, CLI,
  tool profile, enabled on/off.
- Works on Linux, macOS and Windows with the same code path.

Non-goals (v1):

- Sharing the session with the agent tab's interactive PTY. The tab keeps
  working as today; Telegram runs its own headless turns.
- Webhooks. Long polling needs no public URL, which fits a desktop app.
- Group chats, voice notes, images and files. Text only, private chats only.
- Answering while polakapi is closed. The control server lives in the main
  window; the bot lives and dies with it.
- CLIs other than `claude` and `codex`.

## 2. Moving parts

```
Telegram Bot API
  ↑ sendMessage / sendChatAction        ↓ getUpdates (long poll, timeout 50s)
app_control/telegram.rs  (tokio task inside the app, started after the control server)
  allowlist check → per-chat queue → turn runner
                                          ↓ spawn, cwd = <app_data>/agent-home/
  headless CLI turn
    claude -p <text> --output-format json [--resume <session_id>]
           --mcp-config mcp/claude.json --strict-mcp-config
           --allowedTools mcp__polakapi
    codex exec --json [resume <thread_id>] -c mcp_servers.polakapi.… <text>
                                          ↓ spawns as today
  polakapi app-mcp --control <file> --profile <full|readonly>
                                          ↓ control channel (unchanged)
  control-bridge.ts → tools/registry.ts (filters by profile)
```

- **Rust owns the bot.** Polling, the allowlist, queues and process spawning
  live in `src-tauri/src/app_control/telegram.rs` (+ submodules). The webview
  only edits settings and shows status. `reqwest` and `tokio` are already
  dependencies; no new crates.
- **One headless process per turn.** Each message runs the CLI in print/exec
  mode and reads its final result from structured output. Scraping the TUI of
  the agent tab is not an option: it cannot tell where an answer ends.
- **The MCP registration is reused.** `home::prepare_in` already writes the
  per-CLI config; the turn runner calls it and appends the headless flags.

## 3. Configuration

Stored in `telegram.json` through `tauri-plugin-store`, like
`notifications.json`. The Rust side reads the same file at startup and on a
`telegram-config` event when the settings window saves.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | bool | `false` | The bot never starts until the user enables it. |
| `token` | string | `""` | Bot token from @BotFather. |
| `allowedUserIds` | number[] | `[]` | Required. An empty list keeps the bot stopped. |
| `cli` | `"claude" \| "codex"` | `"claude"` | Must be installed (`detect::detect`). |
| `profile` | `"readonly" \| "full"` | `"readonly"` | Which tools the Telegram agent sees. |
| `turnTimeoutSecs` | number | `600` | Kills a turn that runs longer. |

- The token is a secret. The store file is written with mode 0600 on Unix
  (same helper as the control file). It is never logged and never sent to the
  webview after saving: the settings form shows `••••1234` and only accepts a
  replacement. Moving it to the OS keychain is a follow-up if needed.
- Session map (`chatId → { cli, sessionId, updatedAt }`) and the last
  `update_id` offset live in `<app_data>/telegram-state.json`, so a restart
  neither replays old messages nor loses the conversation.

## 4. Security

The tools can type into any terminal (`polakapi_send_to_terminal`), which is
remote command execution on the user's machine. The design treats the bot as
a privileged remote shell:

1. **Allowlist by Telegram user id** (`message.from.id`), not by username,
   which can change. Messages from anyone else are dropped silently (no reply,
   so the bot does not confirm it exists) and counted in the status line.
2. **Private chats only** (`chat.type == "private"`).
3. **No approval prompts are possible headless**, so only polakapi's tools are
   allowed: `--allowedTools mcp__polakapi` for Claude; for Codex,
   `--sandbox read-only` and `-c approval_policy="never"` so its shell tools
   cannot write. The CLI's own file and shell tools stay off.
4. **Tool profile.** `app-mcp` gets a `--profile` flag and sends it with every
   control request. The bridge filters `tools/list` and rejects `tools/call`
   for tools outside the profile. `readonly` exposes: `overview`,
   `project_status`, `agents_status`, `read_terminal`, `skills_list`,
   `skill_read`, `memory_list`, `memory_read`, `agent_context*`,
   `adversarial_status`, `adversarial_findings`, `context_mode_status`. The
   agent tab keeps `full`.
5. **Telegram-specific instructions.** `AGENTS.md` gets a section the CLI
   reads in every turn: messages come from a remote user, answers must be
   short and plain text, and terminal input must be stated back before it is
   sent.
6. **Audit log.** Every turn appends `{ts, chatId, userId, text, tools called,
   ok}` to `<app_data>/telegram-audit.jsonl` (tool names from the bridge, not
   arguments, to keep secrets out).

## 5. Turn runner

Per chat, turns are serialized: a queue of at most 3 pending messages; extra
messages get "busy, try again". Different chats run in parallel up to 2 turns.

1. `sendChatAction(typing)` immediately and every 4s while the turn runs.
2. Build the launch spec with `home::prepare_in(home, cli, bin, control)` and
   the profile, then append the headless flags:
   - claude: `-p <text> --output-format json` plus `--resume <id>` when the
     chat has a session. Read `result` and `session_id` from the JSON.
   - codex: `exec --json --skip-git-repo-check` (plus `resume <id>`), read the
     thread id and the last `agent_message` from the JSONL events.
3. Pass the text as an argument, never through a shell. Spawn with
   `tokio::process::Command`, `kill_on_drop(true)`, timeout `turnTimeoutSecs`.
4. On success: store the session id, send the answer split in chunks of at
   most 4096 characters on line boundaries, as plain text (no `parse_mode`, so
   Markdown in the answer cannot break the request).
5. On failure: reply with a one-line error (`timed out`, `claude exited with
   code 1: <last stderr line>`). If `--resume` fails because the session is
   gone, drop it and retry once without it.

## 6. Bot commands

| Command | Effect |
| --- | --- |
| `/start`, `/help` | Short description and the current CLI and profile. |
| `/new` | Forget this chat's session; the next message starts fresh. |
| `/stop` | Kill the running turn of this chat and clear its queue. |
| `/status` | Calls `polakapi_overview` through the bridge directly (no model) and replies with the summary. |

`setMyCommands` is called when the bot starts so Telegram shows the menu.

## 7. Settings and status UI

- New **Telegram** section in `settings.html` (`src/modules/settings/telegram-section.ts`):
  enable toggle, token field (masked), allowed user ids (comma separated,
  validated as positive integers), CLI select (installed ones only), profile
  select, "Test connection" button (`getMe`, shows the bot's @username).
- Status in the agent tab bar: `telegram: @bot · running` / `stopped` /
  `error: <reason>`, fed by a `telegram-status` event.
- Help text explains how to find a user id (message @userinfobot) and warns
  that `full` lets Telegram users type into terminals.

## 8. Implementation steps

1. **Profile plumbing.** `app-mcp --profile`, forwarded in control requests;
   `registry.ts` gets `READONLY_TOOLS` and filters list/call. Tests in
   `registry.test.ts` and `control-bridge.test.ts`.
2. **Headless launch spec.** `home::headless_args(cli, text, session)` next to
   `prepare_in`; unit tests for both CLIs and for argument escaping.
3. **Telegram API client.** `telegram/api.rs`: `get_me`, `get_updates`,
   `send_message`, `send_chat_action`, `set_my_commands`, with error types for
   401 (bad token), 409 (another poller on the same token) and 429
   (`retry_after`). Tests against a local mock HTTP server.
4. **Config and state.** `telegram/config.rs` (load, validate, 0600 write) and
   `telegram/state.rs` (offset + sessions). Tests for validation and for the
   empty allowlist keeping the bot stopped.
5. **Poller and dispatcher.** `telegram/bot.rs`: the long-poll loop with
   backoff, allowlist and chat-type filtering, per-chat queues, commands.
   Started from `lib.rs` after `server::start`, restarted on `telegram-config`,
   cancelled when the main window closes. Tests for filtering and queueing
   with a fake API and a fake turn runner.
6. **Turn runner.** `telegram/turn.rs`: spawn, timeout, parse claude JSON and
   codex JSONL, chunking, resume fallback. Parsers tested on recorded output.
7. **Instructions and audit.** Telegram section in
   `resources/agent-home/AGENTS.md`; audit log writer.
8. **Settings UI and status.** Section, Tauri commands
   (`telegram_config_get`, `telegram_config_set`, `telegram_test`), status
   event, tests in `settings.test.ts`.
9. **Docs and version.** Update `agent-tab-plan.md` (link here), README
   feature list, and bump the version (minor) in `package.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and
   `src-tauri/Cargo.lock`.

## 9. Files

- New Rust: `src-tauri/src/app_control/telegram.rs`,
  `src-tauri/src/app_control/telegram/{api,bot,config,state,turn}.rs`.
- Touched Rust: `app_control.rs` (module + commands), `app_control/home.rs`
  (headless args), `app_control/mcp.rs` and `client.rs` (`--profile`),
  `app_control/server.rs` (profile passed to the webview), `lib.rs`
  (start/stop, commands).
- New TypeScript: `src/modules/settings/telegram-section.ts` (+ test).
- Touched TypeScript: `src/modules/app-agent/tools/registry.ts`,
  `control-bridge.ts`, `agent-panel.ts` (status), `settings.ts`.
- Resources: `src-tauri/resources/agent-home/AGENTS.md`.

## 10. Verification

- Unit and integration tests above (`pnpm test`, `cargo test`).
- Manual, on Linux first: create a bot with @BotFather, add your user id,
  enable it, then:
  - `/status` answers without spending model tokens.
  - "what projects do I have?" answers through `polakapi_overview`.
  - A follow-up ("and which one has agents running?") reuses the session.
  - A message from a second, non-allowed account gets no reply and shows in
    the status count.
  - In `readonly`, asking to type into a terminal is refused by the bridge.
  - `/stop` during a long turn kills the process.
  - Closing polakapi stops polling; reopening does not replay old messages.

## 11. Open questions

- Should `full` require a confirmation in the chat (inline keyboard
  "Run / Cancel") before `send_to_terminal`, instead of trusting the
  instructions?
- Should the bot notify the chat on its own (agent waiting for permission,
  adversarial review finished), reusing `agent-notifier.ts`?
- OS keychain for the token in v1, or the 0600 store file?

## 12. As built (v1)

Where the implementation differs from the plan above:

- **Config storage.** Rust owns `<app_data>/telegram.json` (written through a
  private temporary file, mode 0600) instead of `tauri-plugin-store`. The
  settings window talks to it with `telegram_config_get`,
  `telegram_config_set`, `telegram_status` and `telegram_test`; saving
  restarts the bot directly, so there is no `telegram-config` event.
- **Prompt on stdin.** Both CLIs read the message from stdin (`claude -p`,
  `codex exec … -`), so a message that starts with `-` is never parsed as a
  flag. Claude also gets `--tools ""` so the user's global allow rules cannot
  re-enable shell or file tools in a turn nobody supervises. Each profile gets
  its own Claude MCP file (`mcp/claude-<profile>.json`), leaving the agent
  tab's `mcp/claude.json` untouched.
- **Stale messages.** Messages older than 5 minutes (sent while polakapi was
  closed) are not run; the bot replies that they were skipped.
- **Audit log.** Entries carry `ts`, `chatId`, `userId`, `text`, `cli`,
  `profile`, `ok`, `error` and `ms`. Tool names are not recorded yet.
- **Status UI.** The bot's state shows in the Telegram settings section, not
  in the agent tab bar.
- **Modules.** `telegram/{api,bot,config,overview,queue,turn}.rs`; offset and
  sessions live in `config.rs` next to the settings.
- **Verification so far.** Unit tests for parsing, config, allowlist, queue
  helpers, profiles and the settings form; Claude's headless flags checked
  against Claude Code 2.1. Codex's headless flags follow `loop_cli.rs` and
  are not verified against an installed codex yet. The manual checklist in
  section 10 still needs a real bot token.

## 13. Reply style, notifications and remote approvals

- **Reply style.** `replyStyle` in settings is the default; `/style <text>`
  overrides it per chat, `/style` shows it and `/style reset` drops the
  override. Claude gets it through `--append-system-prompt`; codex gets it in
  front of the prompt. It is restated every turn, so a change applies to an
  ongoing conversation.
- **Notifications.** `forwardNotifications` (settings, or `/notify on|off`)
  mirrors the agent alerts the main window already delivers: same events, same
  preferences, same timing. `agent-notifier.ts` calls `forwardToTelegram`
  after the desktop delivery, and the `telegram_notify` command sends the text
  to every allowed user.
- **Remote approvals.** With `remoteApprovals` on (settings, or
  `/approvals on|off`), a permission alert carries the prompt read from the
  pane and Allow / Always / Deny buttons. A press is relayed to the main
  window as `permission.respond`; `telegram-relay.ts` re-reads the pane, and
  only if Claude Code's "Do you want to …" prompt is still there it types `1`
  (allow), `2` (always, only when option 2 is a "Yes") or Esc (deny). Each
  prompt answers once and expires after 15 minutes. Verified against Claude
  Code 2.1 in tmux: `1` runs the tool, Esc interrupts it.
- **Live settings.** Only the token and the on/off switch restart the poller.
  Every other setting is read per message, so toggling from the chat never
  cancels a running turn.

## 14. Projects, direct actions and terminal output

- **Project commands.** `/projects` lists every project, numbered in sidebar
  order; `/active` only those with a live terminal or recent output.
  `/project` shows the chat's project with a button per project; `/project
  <number, name or id>` switches and `/project none` forgets it. All of them
  read `polakapi_overview` and spend no model tokens.
- **Chat project.** Each chat keeps a project in `telegram-state.json`
  (`focus`). Every turn's header names it, `polakapi_chat_focus` (a tool only
  Telegram turns see, answered by the Rust side) switches it when the user
  talks about another project, and tools that take `project` get it filled
  in when the model leaves it out.
- **Direct actions.** Turns pass `--origin telegram:<chat>` to `app-mcp`.
  `actions::intercept` sees those calls before the main window does. With
  "Ask before acting" on (settings or `/confirm on|off`) and the Full
  profile, `polakapi_send_to_terminal` and `polakapi_run_command` are held:
  the chat gets the exact text or command with Run / Cancel buttons, and the
  model is told not to ask again in words. Off, they run directly. Each held
  action answers once, only in its chat, and expires after 15 minutes.
- **Terminal output.** `polakapi_run_command` (and `/run <command>` without
  the model) runs the command through the user's login shell in the project
  folder with stdout and stderr merged, no pager and no colors, and returns
  `$ command`, the output and `[exit N]`. Answers are sent as Telegram HTML:
  ``` fences become monospaced `<pre>` blocks, reopened across messages when
  the output is long; anything Telegram rejects is resent as plain text.

## 15. The user's terminals and sudo

- **Commands.** `/terminals` lists every live pane, numbered, with its
  project, its current working directory and what it runs. `/terminal
  <number, ptyId or part of the path>` picks the pane a chat types into (or
  shows buttons); without a choice, the only idle shell of the chat's
  project is used. `/sh <command>` and messages starting with `$ ` run a
  command there; `/peek [lines]` shows the end of the screen.
- **Working directory.** `pty_cwds` reads the cwd of each pane's root process
  (its shell) through sysinfo, so it follows every `cd`. It works on Linux
  and macOS; on Windows the pane's starting folder is shown instead when the
  process cannot be read.
- **When a command is done.** The bash and zsh integration scripts now print
  `OSC 9932;<ptyId>;<exit status>` at every prompt. `runInTerminal`
  (`terminal-remote.ts`) types the command, waits for that marker and
  returns the rows printed since, minus the echoed command and the next
  prompt, plus `[exit N]` on failure. Shells without the integration fall
  back to 1.5 s of quiet output. After 60 s it returns what it has with
  "still running"; a password prompt stops it with "type it at the
  computer", and the password is never relayed. Busy panes and AI CLI panes
  are refused.
- **Agent tools.** `polakapi_terminals` (also in the read-only profile) and
  `polakapi_run_in_terminal`, which is held for Run / Cancel like the other
  actions when "Ask before acting" is on.
- **Sudo.** `privilege::elevation` reads a command line the way a shell
  splits it (separators, pipes, subshells, `$( )` and backticks, `VAR=x`
  prefixes, wrappers such as `env`, `nohup` or `timeout`, and `sh -c`
  scripts) and finds sudo, doas, su, pkexec, run0 and sudoedit. Unless
  "Allow sudo" is on in settings, which the chat cannot change, `/sh`, `$`,
  `/run` and the agent's `polakapi_run_command`, `polakapi_run_in_terminal`
  and `polakapi_send_to_terminal` to a shell pane are refused before
  anything is typed. Aliases, functions and scripts that call sudo
  themselves are not detected; the setting's help says so.
