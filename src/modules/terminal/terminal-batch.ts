import { invoke } from "../../shared/tauri/invoke";
import type { TerminalSpec } from "./types";

// Batch operations over every terminal of a project: closing them all, and
// reloading them (close, then open again from scratch).

export interface RunningPane {
  ptyId: string;
  command: string;
}

/** The slice of TerminalManager these operations need, kept structural so the
 * logic is unit-testable without a DOM or a live PTY. */
export interface BatchTarget {
  ids(): string[];
  specs(): TerminalSpec[];
  isLive(id: string): boolean;
  close(id: string, opts?: { silent?: boolean }): Promise<void>;
  addPane(spec?: Partial<TerminalSpec>): Promise<unknown>;
}

export function fetchRunningPanes(): Promise<RunningPane[]> {
  return invoke<RunningPane[]>("pty_running_commands", {}, { toastOnError: false });
}

/** Live panes that have a process running inside them, in pane order. */
export function busyPanes(
  ids: readonly string[],
  running: readonly RunningPane[],
): Array<{ label: string; command: string }> {
  const byId = new Map(running.map((pane) => [pane.ptyId, pane.command]));
  const busy: Array<{ label: string; command: string }> = [];
  ids.forEach((id, index) => {
    const command = byId.get(id);
    if (command !== undefined) busy.push({ label: `pane ${index + 1}`, command });
  });
  return busy;
}

export function busyMessage(busy: ReadonlyArray<{ label: string; command: string }>): string {
  const header =
    busy.length === 1
      ? "1 terminal is still running something:"
      : `${busy.length} terminals are still running something:`;
  return [header, ...busy.map((pane) => `• ${pane.label}: ${pane.command}`)].join("\n");
}

/**
 * How a pane comes back on reload: same directory, same CLI, same title — but
 * without `launchArgs`, which is where a resume flag like `--continue` lives.
 * Reload reopens the terminal, it does not continue the previous session.
 */
export function reloadSpec(spec: TerminalSpec): Partial<TerminalSpec> {
  return {
    cwd: spec.cwd,
    cliId: spec.cliId,
    title: spec.title,
    startupCmd: spec.startupCmd,
  };
}

export async function closeAllPanes(target: BatchTarget): Promise<void> {
  for (const id of [...target.ids()]) {
    await target.close(id);
  }
}

export async function reloadAllPanes(target: BatchTarget): Promise<void> {
  // Snapshot first: closing drops each spec from the manager.
  const specs = target.specs().map(reloadSpec);
  for (const id of [...target.ids()]) {
    await target.close(id, { silent: true });
  }
  for (const spec of specs) {
    await target.addPane(spec);
  }
}
