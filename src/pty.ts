import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PtyDataEvent = { id: string; data: string };
export type PtyExitEvent = { id: string };

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
}

export function ptySpawn(opts: PtySpawnOptions): Promise<string> {
  return invoke<string>("pty_spawn", {
    cols: opts.cols,
    rows: opts.rows,
    command: opts.command ?? null,
    args: opts.args ?? null,
    cwd: opts.cwd ?? null,
  });
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

export function onPtyData(handler: (ev: PtyDataEvent) => void): Promise<UnlistenFn> {
  return listen<PtyDataEvent>("pty:data", (e) => handler(e.payload));
}

export function onPtyExit(handler: (ev: PtyExitEvent) => void): Promise<UnlistenFn> {
  return listen<PtyExitEvent>("pty:exit", (e) => handler(e.payload));
}
