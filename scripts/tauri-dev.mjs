#!/usr/bin/env node
// Wrapper around the Tauri CLI that lets the Vite dev server port be
// overridden via `TAURI_DEV_PORT`, so multiple worktrees (or a main checkout
// + a worktree) can run `tauri dev` side by side.
//
// Usage:
//   pnpm tauri dev                       # default port 1420
//   TAURI_DEV_PORT=1422 pnpm tauri dev   # worktree / second instance
//
// `tauri.conf.json`'s `build.devUrl` is hard-coded to 1420, so when running
// `tauri dev` we merge a `devUrl` override via `--config` to keep it in sync
// with the Vite port. The env var is propagated to `beforeDevCommand`
// (`pnpm dev`), which Vite reads in `vite.config.ts`. Other subcommands
// (`build`, `info`, ...) are forwarded untouched.

import { spawn } from "node:child_process";

const [subcommand, ...rest] = process.argv.slice(2);
const args = [subcommand, ...rest];

const env = { ...process.env };

if (subcommand === "dev") {
  const port = process.env.TAURI_DEV_PORT ?? "1420";
  const numericPort = Number(port);

  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    console.error(`[tauri-dev] invalid TAURI_DEV_PORT: ${port}`);
    process.exit(1);
  }

  env.TAURI_DEV_PORT = String(numericPort);
  const devUrl = `http://localhost:${numericPort}`;
  args.push("--config", JSON.stringify({ build: { devUrl } }));
}

const child = spawn("tauri", args, {
  stdio: "inherit",
  env,
  shell: true,
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("[tauri-dev] failed to spawn tauri:", err);
  process.exit(1);
});
