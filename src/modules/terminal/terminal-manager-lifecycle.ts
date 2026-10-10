import type { PaneAddOptions, PaneSnapshots, TerminalSpec } from "./types";
import { equalStringArrays } from "./terminal-spec-utils";
import type { TerminalPane } from "./terminal-pane";

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createdPaneSpec(
  id: string,
  cliId: string,
  spec?: Partial<TerminalSpec>,
): TerminalSpec {
  return {
    id,
    cliId,
    title: spec?.title,
    cwd: spec?.cwd,
    startupCmd: spec?.startupCmd,
    launchArgs: spec?.launchArgs,
    lastShellCommand: spec?.lastShellCommand,
    lastShellCommandAlias: spec?.lastShellCommandAlias,
  };
}

export function patchedPaneSpec(
  current: TerminalSpec,
  patch: Partial<Omit<TerminalSpec, "id">>,
): TerminalSpec {
  const next = { ...current, ...patch, id: current.id };
  return next.title === current.title &&
    next.cwd === current.cwd &&
    next.startupCmd === current.startupCmd &&
    next.cliId === current.cliId &&
    equalStringArrays(next.launchArgs, current.launchArgs) &&
    next.suspended === current.suspended &&
    next.lastShellCommand === current.lastShellCommand &&
    next.lastShellCommandAlias === current.lastShellCommandAlias
    ? current
    : next;
}

export class ManagerLifecycle {
  disposed = false;
  frozen = false;
  private released: (() => void) | null = null;
  private handoff: Promise<void> = Promise.resolve();

  thaw(): void {
    this.frozen = false;
    this.released?.();
    this.released = null;
  }
  waitForHandoff(): Promise<void> {
    return this.handoff;
  }
  private readonly pending = new Set<Promise<unknown>>();
  private batchRunning = false;

  async runBatch(operation: () => Promise<void>): Promise<void> {
    if (this.disposed || this.frozen || this.batchRunning) return;
    this.batchRunning = true;
    try {
      await this.track(operation());
    } finally {
      this.batchRunning = false;
    }
  }

  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => undefined);
    return operation;
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  async freeze(): Promise<boolean> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    if (this.disposed || this.frozen) return false;
    this.frozen = true;
    this.handoff = new Promise<void>((resolve) => {
      this.released = resolve;
    });
    return true;
  }
}

export async function restorePaneSpecs(
  specs: TerminalSpec[],
  opts: { adopt?: boolean; snapshots?: PaneSnapshots } | undefined,
  addSuspended: (spec: TerminalSpec) => void,
  addPane: (spec: TerminalSpec, opts?: PaneAddOptions) => Promise<TerminalPane | null>,
): Promise<Map<string, string>> {
  const idMap = new Map<string, string>();
  for (const spec of specs) {
    if (spec.suspended) {
      addSuspended(spec);
      idMap.set(spec.id, spec.id);
      continue;
    }
    const adopt = opts?.adopt
      ? { adoptPtyId: spec.id, skipStartupCmd: true, snapshot: opts.snapshots?.[spec.id] }
      : undefined;
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const pane = await addPane(spec, adopt);
    const restoredId = pane?.el.dataset.ptyId;
    if (restoredId) idMap.set(spec.id, restoredId);
  }
  return idMap;
}
