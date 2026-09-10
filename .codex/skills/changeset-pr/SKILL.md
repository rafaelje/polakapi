---
name: changeset-pr
description: Prepare or create pull requests in polakapi with a required Changesets version bump and validated desktop version consistency.
---

# Changesets for polakapi pull requests

Every PR must include a new `.changeset/*.md` entry declaring `polakapi` as `patch`, `minor`, or `major`, with a concise English release note. Empty changesets do not satisfy this repository's policy, including for tooling and documentation PRs.

1. Compare the complete PR diff with its actual base. Choose patch for fixes and maintenance, minor for new capabilities, and major for breaking changes.
2. Add the entry with `pnpm changeset --patch polakapi --message "Release note"` (or `--minor` / `--major`). Reuse an appropriate changeset already added by this PR; an entry inherited from the base does not count. Update the note if the PR scope changes.
3. Stage the new changeset so Git can detect it. Run `pnpm changeset:status` to verify the intended next version, then `CHANGESET_BASE_REF=<base-ref-or-sha> pnpm changeset:check` and `pnpm run check`. In PowerShell, set `$env:CHANGESET_BASE_REF` before running the check.
4. Include the changeset in the commit and complete the repository PR template, stating the bump type, next version, and validation results. User authorization to create the PR is still required; this skill does not grant it.

A changeset records a pending release. Do not manually bump manifests or claim that the version has been applied. When a release is explicitly requested, `pnpm version:apply` consumes pending changesets, generates the changelog, and synchronizes `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`. Verify with `pnpm versions:check`. Do not retain a consumed changeset as pending, because it would schedule a second bump. Tagging, publishing, and merging require their own task authorization.

The app is private: Changesets versions it but must not publish it to npm. Keep `privatePackages.version: true` and `privatePackages.tag: false` in `.changeset/config.json`.
