# Install polakapi on Windows

Use the PowerShell installer on native Windows x64 to install or upgrade the per-user build. It verifies the release manifest and SHA-256 checksums, then opens the verified NSIS installer and waits for its result. ARM and 32-bit Windows are not supported.

## Quick path

1. Download `install.ps1` from the selected polakapi release and save it locally.
2. In PowerShell, run `.\install.ps1` from the folder where it was saved.
3. Follow the NSIS installer. By default, polakapi installs under `%LOCALAPPDATA%\Programs\polakapi`.

The script honors the machine's PowerShell execution policy. It does not change that policy, disable SmartScreen, or request administrator access. If your policy blocks the script, follow your organization's policy rather than bypassing it.

## Options

```powershell
.\install.ps1 -Help
.\install.ps1 -Version 1.2.3
.\install.ps1 -InstallDir "$env:LOCALAPPDATA\Programs\polakapi"
.\install.ps1 -Source https://example.invalid/releases/v1.2.3 -Version 1.2.3
```

`-Source` must identify a complete release directory containing `manifest.tsv`, `release-version.txt`, the Windows x64 NSIS package, and `install.ps1`. HTTPS is required; HTTP is accepted only for an explicitly supplied loopback source. Redirects are checked individually, limited to five hops, and each request has a timeout. `-Version` must match the release version. Without `-Version`, the public installer resolves the latest stable version once and pins that version for the download.

`-InstallDir` selects the NSIS destination. The NSIS installer remains interactive; the script waits for it and returns a failure exit code if it fails. Close polakapi before reinstalling or upgrading. The installer does not remove application user data.

## Uninstall

Use Windows Settings → Apps to uninstall polakapi through its registered uninstaller. Application settings and workspaces are not intentionally deleted by these bootstrap scripts.

## Verification

Run the Windows public-command tests with `node --test scripts/install-windows.test.mjs` on native Windows. The tests use local HTTP release fixtures and isolated temporary directories. They cover help output, invalid arguments, release-version mismatch, malformed manifests, checksum failure, and insecure redirects without changing existing installation data. A successful packaged Windows installation still requires a native Windows smoke test.
