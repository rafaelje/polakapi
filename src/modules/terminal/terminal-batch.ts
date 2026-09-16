import { invoke } from "../../shared/tauri/invoke";
import type { LayoutTemplate } from "../workspaces/state/types";
import { buildLayoutTemplate } from "./layout-templates";
import type { TerminalLayoutNode } from "./terminal-layout";
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
  /** The split tree, including each split's axis and ratio. */
  readonly layoutSnapshot: TerminalLayoutNode | null;
  close(id: string, opts?: { silent?: boolean }): Promise<void>;
  addPane(spec?: Partial<TerminalSpec>): Promise<unknown>;
  applyTemplate(template: LayoutTemplate): Promise<void>;
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

/**
 * The current arrangement as a template: every pane with its directory, CLI,
 * title and startup command, plus the split tree with its axes and ratios.
 * Spec ids are the live pane ids the tree refers to, which is what lets the
 * template map each old position onto the pane that replaces it.
 */
export function reloadTemplate(
  specs: readonly TerminalSpec[],
  layout: TerminalLayoutNode | null,
): LayoutTemplate | null {
  const base = buildLayoutTemplate("reload", specs, layout);
  if (!base) return null;
  const cwdById = new Map(specs.map((spec) => [spec.id, spec.cwd]));
  return {
    ...base,
    specs: base.specs.map((spec) => {
      const cwd = cwdById.get(spec.id);
      return cwd ? { ...spec, cwd } : spec;
    }),
  };
}

export async function reloadAllPanes(target: BatchTarget): Promise<void> {
  // Capture before closing: each close drops its spec and prunes the tree.
  const specs = target.specs();
  const template = reloadTemplate(specs, target.layoutSnapshot);
  for (const id of [...target.ids()]) {
    await target.close(id, { silent: true });
  }
  if (template) {
    await target.applyTemplate(template);
    return;
  }
  // No tree to restore, so there are no positions to keep: reopen in order.
  for (const spec of specs) {
    await target.addPane(reloadSpec(spec));
  }
}
