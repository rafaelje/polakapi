import type { ContextGroup, ContextRow, PaneContext } from "./types";
import type { ProjectId } from "../workspaces/state/types";

const BAR_WIDTH = 10;

/** Compact token count: 1_234 -> "1.2k", 118_000 -> "118k". */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1_000) return String(Math.round(tokens));
  const thousands = tokens / 1_000;
  if (thousands < 10) return `${thousands.toFixed(1)}k`;
  if (thousands < 1_000) return `${Math.round(thousands)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function contextPercent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

/** Text progress bar, matching the monospace look of the sidebar. */
export function contextBar(percent: number, width = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Severity band driving the bar colour. */
export function contextLevel(percent: number): "ok" | "warn" | "high" {
  if (percent >= 85) return "high";
  if (percent >= 60) return "warn";
  return "ok";
}

export function formatRam(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return "0 MB";
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function formatCpu(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return "0%";
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  if (days > 0) return `${days}d ${Math.floor((total % 86_400) / 3_600)}h`;
  const hours = Math.floor(total / 3_600);
  if (hours > 0) return `${hours}h ${Math.floor((total % 3_600) / 60)}m`;
  const minutes = Math.floor(total / 60);
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

export function formatCost(cost: number | null): string | null {
  if (cost === null || !Number.isFinite(cost) || cost <= 0) return null;
  return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

/** Drops the vendor prefix and date suffix: "claude-opus-5" -> "opus-5". */
export function shortModel(model: string | null): string | null {
  if (!model) return null;
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function toolSummary(context: PaneContext, max = 4): string | null {
  if (context.tools.length === 0) return null;
  return context.tools
    .slice(0, max)
    .map((tool) => tool.name)
    .join("·");
}

export function fileSummary(context: PaneContext, max = 2): string | null {
  if (context.files.length === 0) return null;
  const shown = context.files.slice(0, max).join(", ");
  const rest = context.files.length - max;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/**
 * Groups live panes by project, preserving the caller's project order and
 * dropping projects with no live pane. Rows keep their incoming order so the
 * panel matches the pane order in the grid.
 */
export function groupByProject(
  rows: readonly ContextRow[],
  projectNames: ReadonlyMap<ProjectId, string>,
): ContextGroup[] {
  const groups = new Map<ProjectId, ContextGroup>();
  for (const row of rows) {
    let group = groups.get(row.projectId);
    if (!group) {
      group = {
        projectId: row.projectId,
        projectName: projectNames.get(row.projectId) ?? "unknown project",
        rows: [],
      };
      groups.set(row.projectId, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}
