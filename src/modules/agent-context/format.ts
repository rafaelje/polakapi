import type {
  BreakdownKey,
  BreakdownRow,
  ContextBreakdown,
  ContextEntry,
  EntryKind,
  SortMode,
} from "./types";

const BAR_WIDTH = 10;
const SORT_MODES: readonly SortMode[] = ["oldest", "newest", "largest", "smallest"];

const BREAKDOWN_LABELS: Record<BreakdownKey, string> = {
  instructions: "instructions",
  files: "file contents",
  toolOutput: "tool output",
  messages: "messages",
  thinking: "thinking",
};

const KIND_LABELS: Record<EntryKind, string> = {
  instructions: "injected",
  "user-prompt": "you",
  "assistant-text": "agent",
  thinking: "thinking",
  "tool-call": "tool call",
  "file-content": "file",
  "tool-output": "output",
};

/** Compact token count: 1_234 -> "1.2k", 118_000 -> "118k". */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1_000) return String(Math.round(tokens));
  const thousands = tokens / 1_000;
  if (thousands < 10) return `${thousands.toFixed(1)}k`;
  if (thousands < 1_000) return `${Math.round(thousands)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatBytes(chars: number): string {
  if (!Number.isFinite(chars) || chars <= 0) return "0 B";
  if (chars < 1024) return `${Math.round(chars)} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
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

export function contextPercent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

/** Text progress bar, matching the monospace look of the window. */
export function contextBar(percent: number, width = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Occupancy as text. A zero limit means we do not know the model's window —
 * show the raw count rather than a confident-looking percentage computed from
 * an invented denominator.
 */
export function contextLabel(tokens: number, limit: number): string {
  const used = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  if (limit <= 0) {
    return used > 0 ? `${formatTokens(used)} · window size unknown` : "no token data";
  }
  return `${formatTokens(used)} / ${formatTokens(limit)} (${contextPercent(used, limit)}%)`;
}

/** Severity band driving the bar colour. */
export function contextLevel(percent: number): "ok" | "warn" | "high" {
  if (percent >= 85) return "high";
  if (percent >= 60) return "warn";
  return "ok";
}

/** Strips the vendor prefix and date suffix: "claude-opus-5" -> "opus-5". */
export function shortModel(model: string | null): string | null {
  if (!model) return null;
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function kindLabel(kind: EntryKind): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * Breakdown as rows sorted by weight, each with its share of the estimated
 * total. Zero rows are kept: "no file contents loaded" is itself an answer to
 * "is the agent missing something".
 */
export function breakdownRows(breakdown: ContextBreakdown): BreakdownRow[] {
  const keys = Object.keys(BREAKDOWN_LABELS) as BreakdownKey[];
  const total = keys.reduce((sum, key) => sum + (breakdown[key] || 0), 0);
  return keys
    .map((key) => {
      const tokens = breakdown[key] || 0;
      return {
        key,
        label: BREAKDOWN_LABELS[key],
        tokens,
        percent: total > 0 ? Math.round((tokens / total) * 100) : 0,
      };
    })
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * Sorts a copy of the entries. Chronological order is the entry id, which is
 * the order the transcript produced them — timestamps repeat within a turn and
 * would shuffle blocks that belong together.
 */
export function sortEntries(entries: readonly ContextEntry[], mode: SortMode): ContextEntry[] {
  const sorted = [...entries];
  switch (mode) {
    case "newest":
      return sorted.sort((a, b) => b.id - a.id);
    case "largest":
      return sorted.sort((a, b) => b.estTokens - a.estTokens || a.id - b.id);
    case "smallest":
      return sorted.sort((a, b) => a.estTokens - b.estTokens || a.id - b.id);
    default:
      return sorted.sort((a, b) => a.id - b.id);
  }
}

export function isSortMode(value: string): value is SortMode {
  return SORT_MODES.includes(value as SortMode);
}

export function formatClock(timestamp: string | null): string {
  if (!timestamp) return "";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}
