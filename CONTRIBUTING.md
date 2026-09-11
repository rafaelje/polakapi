# Contributing to polakapi

Thank you for contributing to polakapi. Bug reports, feature proposals, documentation improvements, tests, and code changes are welcome.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before You Start

- Search existing issues and pull requests before opening a new one.
- Use the appropriate issue form for bug reports or feature proposals.
- Discuss large, cross-platform, security-sensitive, or architectural changes in an issue before implementation.
- Report vulnerabilities according to [SECURITY.md](SECURITY.md), never in a public issue.

## Development Setup

Requirements:

- Node.js 22.11 or later in the Node.js 22 LTS line.
- pnpm 11.8.0.
- Rust stable with `rustfmt` and `clippy`.
- The Tauri system dependencies listed in `.github/workflows/ci.yml` when developing on Linux.
- The [Windows prerequisites and PowerShell setup](README.md#windows-setup) when developing on Windows.

Install dependencies and start the desktop app:

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

## Making Changes

1. Fork the repository and create a focused branch from `main`.
2. Keep each change scoped to one problem.
3. Write code and comments in English.
4. Add comments only when they are necessary to explain behavior that is not clear from the code.
5. Add or update tests for behavior changes.
6. Update documentation when commands, configuration, permissions, or user-facing behavior changes.

Prefer Conventional Commit-style messages such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, or `chore:`.

## Package Versions

Every pull request must increase the version in `package.json`, including
maintenance and documentation changes. Use patch for fixes and maintenance,
minor for new capabilities, and major for breaking changes.

The CI `Package version bump` check validates `package.json`,
`src-tauri/tauri.conf.json`, the package entry in `src-tauri/Cargo.toml`, and
the `polakapi` entry in `src-tauri/Cargo.lock`. Each version must be valid
semantic versioning and greater than its value at the pull request's base SHA,
and all four current values must match. Unchanged, lower, invalid, or
misaligned versions fail. For example, if the base is `0.11.0`, a patch PR
should contain `0.11.1` in every file. If the base version advances before
merging, update the PR version again. The existing desktop release workflow
builds and publishes the committed version after merge.

## Quality Checks

Run the complete local quality gate before opening a pull request:

```sh
pnpm run check
```

If a change is platform-specific, test it on the affected operating system when possible and describe any untested platforms in the pull request.

For Windows-specific native changes, also build the NSIS installer:

```powershell
pnpm tauri build --bundles nsis
```

## Pull Requests

- Complete the pull request template.
- Link related issues.
- Explain the user impact and important implementation decisions.
- Include screenshots or recordings for visible interface changes.
- Document security, privacy, filesystem, process execution, or permission implications.
- Keep generated files, local databases, logs, credentials, and build outputs out of commits.

Pull requests require passing status checks and maintainer review. A maintainer may ask for additional tests, documentation, or a smaller scope before merging.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
