# polakapi

polakapi is a cross-platform desktop workspace for running AI coding agents and terminal sessions side by side.

![polakapi desktop workspace showing Codex and Claude Code sessions](assets/screen.png)

## Highlights

- Run multiple terminal-based coding agents in a single window.
- Organize repositories and sessions into persistent workspaces.
- Manage active processes, notes, prompts, and agent workflows from one interface.
- Use Claude Code, Codex, OpenCode, or any other terminal-based tool.

## Getting Started

### Requirements

- Node.js 22
- pnpm 11.8
- Rust stable
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system

### Run Locally

```sh
git clone https://github.com/rafaelje/polakapi.git
cd polakapi
pnpm install --frozen-lockfile
pnpm tauri dev
```

AI coding CLIs are optional and must be installed separately and available on your `PATH`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and contribution guidelines. Security vulnerabilities should be reported according to [SECURITY.md](SECURITY.md).

## License

polakapi is available under the [MIT License](LICENSE).
