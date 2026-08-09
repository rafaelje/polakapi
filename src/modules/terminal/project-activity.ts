import type { ProjectId } from "../workspaces/state/types";

export type ProjectActivityState = "working" | "ready" | "recent" | "idle";

export const WORKING_ACTIVITY_MS = 3_000;
export const RECENT_ACTIVITY_MS = 15 * 60_000;
export const ACTIVITY_CONFIRMATION_WINDOW_MS = 800;
export const ACTIVITY_CONFIRMATION_GAP_MS = 120;

export interface ProjectActivityTrackerOptions {
  getLiveCount(projectId: ProjectId): number;
  onChange(projectId: ProjectId, state: ProjectActivityState): void;
  workingMs?: number;
  recentMs?: number;
  confirmationWindowMs?: number;
  confirmationGapMs?: number;
}

export class ProjectActivityTracker {
  private readonly lastActivity = new Map<ProjectId, number>();
  private readonly activityCandidates = new Map<ProjectId, Map<string, number>>();
  private readonly states = new Map<ProjectId, ProjectActivityState>();
  private readonly timers = new Map<
    ProjectId,
    { handle: ReturnType<typeof setTimeout>; deadline: number }
  >();
  private readonly workingMs: number;
  private readonly recentMs: number;
  private readonly confirmationWindowMs: number;
  private readonly confirmationGapMs: number;

  constructor(private readonly opts: ProjectActivityTrackerOptions) {
    this.workingMs = opts.workingMs ?? WORKING_ACTIVITY_MS;
    this.recentMs = opts.recentMs ?? RECENT_ACTIVITY_MS;
    this.confirmationWindowMs = opts.confirmationWindowMs ?? ACTIVITY_CONFIRMATION_WINDOW_MS;
    this.confirmationGapMs = opts.confirmationGapMs ?? ACTIVITY_CONFIRMATION_GAP_MS;
  }

  get(projectId: ProjectId): ProjectActivityState {
    return this.compute(projectId, Date.now());
  }

  record(projectId: ProjectId, sourceId: string, at = Date.now()): void {
    let candidates = this.activityCandidates.get(projectId);
    if (!candidates) {
      candidates = new Map();
      this.activityCandidates.set(projectId, candidates);
    }
    const candidate = candidates.get(sourceId);
    const elapsed = candidate === undefined ? null : at - candidate;
    if (
      elapsed !== null &&
      elapsed >= this.confirmationGapMs &&
      elapsed <= this.confirmationWindowMs
    ) {
      candidates.delete(sourceId);
      if (candidates.size === 0) this.activityCandidates.delete(projectId);
      this.lastActivity.set(projectId, at);
    } else if (elapsed === null || elapsed < 0 || elapsed > this.confirmationWindowMs) {
      candidates.set(sourceId, at);
    }
    this.update(projectId, at);
  }

  refresh(projectId: ProjectId): void {
    if (this.opts.getLiveCount(projectId) === 0) this.activityCandidates.delete(projectId);
    this.update(projectId, Date.now());
  }

  delete(projectId: ProjectId): void {
    this.clearTimer(projectId);
    this.lastActivity.delete(projectId);
    this.activityCandidates.delete(projectId);
    this.states.delete(projectId);
  }

  dispose(): void {
    for (const { handle } of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    this.lastActivity.clear();
    this.activityCandidates.clear();
    this.states.clear();
  }

  private compute(projectId: ProjectId, now: number): ProjectActivityState {
    const liveCount = this.opts.getLiveCount(projectId);
    const lastActivity = this.lastActivity.get(projectId);
    if (liveCount > 0 && lastActivity !== undefined && now - lastActivity < this.workingMs) {
      return "working";
    }
    if (liveCount > 0) return "ready";
    if (lastActivity !== undefined && now - lastActivity < this.recentMs) return "recent";
    return "idle";
  }

  private update(projectId: ProjectId, now: number): void {
    const state = this.compute(projectId, now);
    if (this.states.get(projectId) !== state) {
      this.states.set(projectId, state);
      this.opts.onChange(projectId, state);
    }
    this.schedule(projectId, now);
  }

  private schedule(projectId: ProjectId, now: number): void {
    const lastActivity = this.lastActivity.get(projectId);
    const liveCount = this.opts.getLiveCount(projectId);
    let deadline: number | null = null;
    if (lastActivity !== undefined) {
      if (liveCount > 0 && now - lastActivity < this.workingMs) {
        deadline = lastActivity + this.workingMs;
      } else if (liveCount === 0 && now - lastActivity < this.recentMs) {
        deadline = lastActivity + this.recentMs;
      }
    }

    if (deadline === null) {
      this.clearTimer(projectId);
      return;
    }

    const scheduled = this.timers.get(projectId);
    if (scheduled && scheduled.deadline <= deadline) return;
    this.clearTimer(projectId);
    const handle = setTimeout(
      () => {
        this.timers.delete(projectId);
        this.update(projectId, Date.now());
      },
      Math.max(0, deadline - now),
    );
    this.timers.set(projectId, { handle, deadline });
  }

  private clearTimer(projectId: ProjectId): void {
    const scheduled = this.timers.get(projectId);
    if (!scheduled) return;
    clearTimeout(scheduled.handle);
    this.timers.delete(projectId);
  }
}
