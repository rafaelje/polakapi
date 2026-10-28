# Review run executes in an interactive CLI terminal

The Review run starts the chosen CLI (`claude`, `codex`, `opencode`, `cursor`) in an interactive polakapi terminal and types the prompt there, letting the CLI orchestrate its own reviewer agents (a Workflow in Claude Code, parallel agents in codex). polakapi does not fan out one headless `-p` call per Process itself, even though `/adversarial` already orchestrates from the app.

We chose this because the user can watch, steer and interrupt the run live, and each CLI's native multi-agent features stay available. The cost is that polakapi cannot track per-Process progress directly; it learns the Verdicts only from the files the run writes to `docs/code-review/<branch>/`.
