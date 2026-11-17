# Install polakapi on macOS or Linux

The POSIX installer fetches a published, versioned release, checks its SHA-256 digest, then installs it for the current user. It does not remove macOS quarantine or bypass platform protections. Run the command for your platform from a terminal.

## Install or upgrade

Install the latest stable release:

```sh
curl -fsSL https://github.com/rafaelje/polakapi/releases/latest/download/install.sh | sh
```

Pin a version or choose an application directory:

```sh
sh install.sh --version 1.2.3
sh install.sh --install-dir "$HOME/.local/opt/polakapi"
```

The same command reinstalls or upgrades an existing installation. Close polakapi before replacing a running app. macOS installs `polakapi.app` under `~/Applications` by default; Linux installs an AppImage under `~/.local/opt/polakapi`, with a launcher in `~/.local/bin` and a desktop entry in the XDG applications directory. Add `~/.local/bin` to `PATH` if needed.

## Inspect a release before installing

A versioned release directory contains `manifest.tsv`, `release-version.txt`, and the platform package. The installer validates the manifest as data and verifies the selected asset checksum before replacing an installation. To inspect without installing, download the release manifest and compare the listed digest with the asset using `shasum -a 256` or `sha256sum`.

For a local test release, `--source URL` accepts HTTPS or an explicit loopback HTTP URL. It selects a complete release directory; when combined with `--version`, the manifest must match that version.

## Uninstall

Remove the app and user shortcuts for the platform:

- macOS: remove `~/Applications/polakapi.app` (or the chosen install directory's app).
- Linux: remove `~/.local/opt/polakapi/polakapi.AppImage`, `~/.local/bin/polakapi`, and `~/.local/share/applications/polakapi.desktop` (or their configured locations).

The installer does not remove user data.

## Platform notes

The initial packages support universal macOS and x64 Linux. Git Bash delegates to the verified PowerShell installer with process-scoped `RemoteSigned`; saved execution policies are unchanged and Group Policy still takes precedence. See the [Windows policy details](install-windows.md#git-bash). WSL is refused so users can choose the native Windows installer explicitly. Unsupported operating systems and architectures are rejected. macOS packages use ad-hoc signing and may still be subject to macOS security prompts.
