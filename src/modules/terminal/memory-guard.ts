import { invoke } from "../../shared/tauri/invoke";
import { showToast } from "../../shared/ui/toast";
import { resolveProfile } from "./cli-registry";

export interface SessionMemory {
  id: string;
  rssMb: number;
}

export interface MemoryStats {
  totalMb: number;
  availableMb: number;
  sessions: SessionMemory[];
}

export interface LivePane {
  paneId: string;
  projectId: string;
  cliId?: string;
  lastActivityAt: number;
}

export interface PaneMemory extends LivePane {
  rssMb: number;
}

const POLL_MS = 15_000;
const WARN_COOLDOWN_MS = 5 * 60_000;

export function fetchMemoryStats(): Promise<MemoryStats> {
  return invoke<MemoryStats>("pty_memory_stats", {}, { toastOnError: false });
}

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

/** Shells are exempt: an idle-looking shell may host a quiet dev server. */
export function planIdleSuspensions(
  panes: readonly LivePane[],
  idleLimitMs: number,
  activeProjectId: string | null,
  now: number,
): LivePane[] {
  if (idleLimitMs <= 0) return [];
  return panes.filter(
    (pane) =>
      pane.projectId !== activeProjectId &&
      resolveProfile(pane.cliId).kind === "ai-cli" &&
      now - pane.lastActivityAt >= idleLimitMs,
  );
}

export function formatMemoryIndicator(usedMb: number, limitMb: number): string {
  const gb = (mb: number): string => (mb / 1024).toFixed(1);
  return limitMb > 0 ? `RAM ${gb(usedMb)}/${gb(limitMb)}G` : `RAM ${gb(usedMb)}G`;
}

export interface MemoryGuardDeps {
  getPanes(): LivePane[];
  getActiveProjectId(): string | null;
  getLimitMb(): number;
  getIdleLimitMs(): number;
  suspendPane(paneId: string): void;
  onStats?(stats: MemoryStats, usedMb: number): void;
}

export interface MemoryGuardHandle {
  tick(): Promise<void>;
  dispose(): void;
}

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
    const activeProjectId = deps.getActiveProjectId();
    const { suspend, usedMb } = planMemoryRelief(panes, limitMb, activeProjectId);
    deps.onStats?.(stats, usedMb);

    const taken = new Set(suspend.map((pane) => pane.paneId));
    const idle = planIdleSuspensions(
      panes.filter((pane) => !taken.has(pane.paneId)),
      deps.getIdleLimitMs(),
      activeProjectId,
      Date.now(),
    );
    for (const pane of [...suspend, ...idle]) deps.suspendPane(pane.paneId);

    if (idle.length > 0) {
      showToast(
        `Idle: suspended ${idle.length} background AI terminal${idle.length > 1 ? "s" : ""}`,
        "info",
      );
    }
    if (suspend.length > 0) {
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
