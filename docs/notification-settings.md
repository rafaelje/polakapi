# App settings and notifications

Open **polakapi → Settings…** (`Cmd+,` on macOS, `Ctrl+,` elsewhere). The settings window has one **App** section with six rows:

- **Agent Needs Permission**: permission alerts from Claude hooks.
- **Agent Finished**: Never, Immediately, or When idle. Idle delivery waits for tracked terminal agents, Claude subagents, and active loop runs.
- **Agent Waiting for Input**: idle-input alerts from Claude hooks, suppressed while other tracked work is active.
- **Desktop Notifications**: enable desktop delivery, inspect plugin permission status, open system notification settings, or send a test.
- **Notification Sound**: system default, no sound, installed system sounds, or a custom audio file, with preview and clear actions.
- **Notification Command**: an optional shell command, with `POLAKAPI_NOTIFICATION_TITLE` and `POLAKAPI_NOTIFICATION_BODY` in its environment. Commands time out after 15 seconds.

Use **Enable agent hooks** once and restart existing Claude/Codex sessions. It installs or updates polakapi-managed hooks while preserving user hooks. Claude supports permission, waiting, completion, and subagent tracking; Codex uses the existing completion hook integration. Agents without compatible hooks still have terminal-bell notifications. Completion of a loop run also uses these preferences.

Preferences are saved in `notifications.json` in the app configuration directory and propagate to the running main window. Hook events use a bounded, transient SQLite queue; they do not save assistant response content. Old queued events expire after 30 seconds. Idle detection covers events observed by polakapi, not arbitrary external processes or future scheduled tasks.

On macOS, sounds are discovered in `/System/Library/Sounds`, `/Library/Sounds`, and `~/Library/Sounds`. Windows lists its Media directory and uses WAV files. Linux lists standard freedesktop/GNOME sounds and requires `paplay` for previews/custom playback; the system-settings shortcut targets GNOME. Focus modes and OS notification settings control whether a banner is visible. Custom sounds and commands remain independent of the desktop-delivery toggle.

**polakapi → Check for updates...** checks the existing GitHub release source on demand, reports success or failure, and offers to open the download page when a newer release exists. It does not install updates automatically.
