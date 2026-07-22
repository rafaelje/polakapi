import { invoke } from "../../shared/tauri/invoke";
import { showToast } from "../../shared/ui/toast";

export interface SessionMemory {
  id: string;
  rssMb: number;
}

export interface MemoryStats {
  totalMb: number;
  availableMb: number;
  sessions: SessionMemory[];
}

export interface PaneMemory {
  paneId: string;
  projectId: string;
  rssMb: number;
}

const POLL_MS = 15_000;
const WARN_COOLDOWN_MS = 5 * 60_000;

export function fetchMemoryStats(): Promise<MemoryStats> {
  return invoke<MemoryStats>("pty_memory_stats", {}, { toastOnError: false });
}

/**
 * Picks which panes to suspend to bring total terminal memory under
 * `limitMb`. Only panes of non-active projects are candidates — the project
 * the user is looking at is never auto-suspended — heaviest process tree
 * first so the fewest panes are touched.
 */
export function planMemoryRelief(
  panes: readonly PaneMemory[],
  limitMb: number,
  activeProjectId: string | null,
): { suspend: PaneMemory[]; usedMb: number } {
  const usedMb = panes.reduce((sum, pane) => sum + pane.rssMb, 0);
  if (limitMb <= 0 || usedMb <= limitMb) return { suspend: [], usedMb };
  const candidates = panes
    .filter((pane) => pane.projectId !== activeProjectId)
    .sort((a, b) => b.rssMb - a.rssMb);
  const suspend: PaneMemory[] = [];
  let projected = usedMb;
  for (const pane of candidates) {
    if (projected <= limitMb) break;
    suspend.push(pane);
    projected -= pane.rssMb;
  }
  return { suspend, usedMb };
}

/** "RAM 3.1/9.6G" — terminal usage vs the configured limit (or "off"). */
export function formatMemoryIndicator(usedMb: number, limitMb: number): string {
  const gb = (mb: number): string => (mb / 1024).toFixed(1);
  return limitMb > 0 ? `RAM ${gb(usedMb)}/${gb(limitMb)}G` : `RAM ${gb(usedMb)}G`;
}

export interface MemoryGuardDeps {
  getPanes(): Array<{ paneId: string; projectId: string }>;
  getActiveProjectId(): string | null;
  /** Current limit in MB; <= 0 disables enforcement (stats still polled). */
  getLimitMb(): number;
  suspendPane(paneId: string): void;
  /** Fires every poll with fresh stats — drives the toolbar indicator. */
  onStats?(stats: MemoryStats, usedMb: number): void;
}

export interface MemoryGuardHandle {
  tick(): Promise<void>;
  dispose(): void;
}

/**
 * Polls `pty_memory_stats` and auto-suspends background panes when the
 * terminals' summed process-tree RSS exceeds the limit. If the overage comes
 * entirely from the active project (no candidates), it warns instead —
 * rate-limited so the toast does not nag every poll.
 */
export function startMemoryGuard(deps: MemoryGuardDeps): MemoryGuardHandle {
  let disposed = false;
  let lastWarnAt = 0;

  const tick = async (): Promise<void> => {
    if (disposed) return;
    const stats = await fetchMemoryStats().catch(() => null);
    if (!stats || disposed) return;
    const rssBySession = new Map(stats.sessions.map((s) => [s.id, s.rssMb]));
    const panes: PaneMemory[] = deps
      .getPanes()
      .map((pane) => ({ ...pane, rssMb: rssBySession.get(pane.paneId) ?? 0 }));
    const limitMb = deps.getLimitMb();
    const { suspend, usedMb } = planMemoryRelief(panes, limitMb, deps.getActiveProjectId());
    deps.onStats?.(stats, usedMb);

    if (suspend.length > 0) {
      for (const pane of suspend) deps.suspendPane(pane.paneId);
      const freedMb = suspend.reduce((sum, pane) => sum + pane.rssMb, 0);
      showToast(
        `Memory limit: suspended ${suspend.length} background terminal${suspend.length > 1 ? "s" : ""} (~${freedMb} MB)`,
        "info",
      );
      return;
    }
    if (limitMb > 0 && usedMb > limitMb && Date.now() - lastWarnAt > WARN_COOLDOWN_MS) {
      lastWarnAt = Date.now();
      showToast(
        `Terminals use ${usedMb} MB (limit ${limitMb} MB) — all in the active project; suspend manually to free RAM`,
        "error",
      );
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), POLL_MS);
  return {
    tick,
    dispose(): void {
      disposed = true;
      clearInterval(timer);
    },
  };
}
