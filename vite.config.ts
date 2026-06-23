import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// Allow overriding the dev server port so multiple worktrees (or a main
// checkout + a worktree) can run `tauri dev` side by side. Defaults to the
// canonical 1420 used by `tauri.conf.json`'s `devUrl`.
const port = Number(process.env.TAURI_DEV_PORT) || 1420;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: port + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
