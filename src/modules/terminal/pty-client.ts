import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "../../shared/tauri/invoke";

/** `offset` is where the chunk ends in the PTY's output, see `ptyAttach`. */
export type PtyDataEvent = { id: string; data: string; offset?: number };
export type PtyExitEvent = { id: string };

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
}

export function ptySpawn(opts: PtySpawnOptions): Promise<string> {
  return invoke<string>(
    "pty_spawn",
    {
      cols: opts.cols,
      rows: opts.rows,
      command: opts.command ?? null,
      args: opts.args ?? null,
      cwd: opts.cwd ?? null,
    },
    { errorMessage: "Failed to spawn terminal" },
  );
}

export function ptyWrite(id: string, data: string): Promise<void> {
  // High-frequency: don't surface a toast per keystroke if PTY is gone.
  return invoke("pty_write", { id, data }, { toastOnError: false });
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows }, { toastOnError: false });
}

export interface PtyAttachment {
  data: string;
  offset: number;
}

/** Output of a running PTY after `since` (all that is kept when omitted), for
 * a window taking over its rendering. */
export function ptyAttach(id: string, since?: number): Promise<PtyAttachment> {
  return invoke<PtyAttachment>(
    "pty_attach",
    { id, since: since ?? null },
    { errorMessage: "Failed to attach terminal" },
  );
}

export function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id }, { toastOnError: false });
}

export function onPtyData(handler: (ev: PtyDataEvent) => void): Promise<UnlistenFn> {
  return listen<PtyDataEvent>("pty:data", (e) => handler(e.payload));
}

export function onPtyExit(handler: (ev: PtyExitEvent) => void): Promise<UnlistenFn> {
  return listen<PtyExitEvent>("pty:exit", (e) => handler(e.payload));
}
