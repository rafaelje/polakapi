#!/usr/bin/env node
// Wrapper around the Tauri CLI that lets the Vite dev server port be
// overridden via `TAURI_DEV_PORT`, so multiple worktrees (or a main checkout
// + a worktree) can run `tauri dev` side by side.
//
// Usage:
//   pnpm tauri dev                                    # default port 1420
//   TAURI_DEV_PORT=1422 pnpm tauri dev                # POSIX second instance
//   $env:TAURI_DEV_PORT = "1422"; pnpm tauri dev      # PowerShell second instance
//
// `tauri.conf.json`'s `build.devUrl` is hard-coded to 1420, so when running
// `tauri dev` we merge a `devUrl` override via `--config` to keep it in sync
// with the Vite port. The env var is propagated to `beforeDevCommand`
// (`pnpm dev`), which Vite reads in `vite.config.ts`. Other subcommands
// (`build`, `info`, ...) are forwarded untouched.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import tauriCliPackage from "@tauri-apps/cli/package.json" with { type: "json" };
import { buildTauriArgs, childExitCode } from "./tauri-dev-args.mjs";

const env = { ...process.env };
let invocation;

try {
  invocation = buildTauriArgs(process.argv.slice(2), process.env.TAURI_DEV_PORT);
} catch (error) {
  console.error(`[tauri-dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (invocation.devPort) {
  env.TAURI_DEV_PORT = invocation.devPort;
}

// Resolve the local `@tauri-apps/cli` JS entry directly and run it with node.
// Going through `node_modules/.bin/tauri` (a shell shim) re-parses argv via
// `"$@"` and strips the double quotes from the JSON `--config` value.
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriPackageRoot = join(projectRoot, "node_modules", ...tauriCliPackage.name.split("/"));
const tauriJs = join(tauriPackageRoot, tauriCliPackage.bin.tauri);

const child = spawn(process.execPath, [tauriJs, ...invocation.args], {
  stdio: "inherit",
  env,
});

child.on("exit", (code) => process.exit(childExitCode(code)));
child.on("error", (err) => {
  console.error("[tauri-dev] failed to spawn tauri:", err);
  process.exit(1);
});
