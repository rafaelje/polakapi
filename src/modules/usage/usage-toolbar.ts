import { invoke } from "../../shared/tauri/invoke";
import type { CodexRateWindow, UsageReport } from "./types";

// Two brand-marked chips pinned to the toolbar: brand glyph + a thin
// progress bar (session window) + inline text "58% 5h · 41% wk". Reads
// the same `usage_summary` command as the panel and polls every REFRESH_MS
// while the window is visible. Clicking a chip opens the usage tab.

const REFRESH_MS = 60_000;

export interface UsageToolbarOptions {
  host: HTMLElement;
}

export interface UsageToolbarHandle {
  refresh(): Promise<void>;
  dispose(): void;
}

interface ChipState {
  /** 0..100. Drives the bar and comes first in the label. */
  session: number | null;
  /** 0..100. Second half of the label. When null the unit is omitted. */
  weekly: number | null;
  /** How much of the label to render (both stats, or weekly only). */
  layout: "session-and-weekly" | "weekly-only";
}

interface ChipHandle {
  root: HTMLButtonElement;
  fill: HTMLElement;
  text: HTMLElement;
  setState(state: ChipState, tooltip: string): void;
}

export function mountUsageToolbar(opts: UsageToolbarOptions): UsageToolbarHandle {
  const { host } = opts;
  host.replaceChildren();
  host.classList.add("usage-indicators");

  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const load = async (): Promise<void> => {
    if (disposed || inFlight) return;
    inFlight = true;
    setBusy(true);
    try {
      const report = await invoke<UsageReport>("usage_summary", undefined, {
        toastOnError: false,
      });
      if (disposed) return;
      render(claude, codex, report);
    } catch {
      // Network hiccups shouldn't disturb the toolbar — next tick retries.
    } finally {
      inFlight = false;
      setBusy(false);
    }
  };

  // The chips call load() on click. A pulsing dimmer during the fetch gives
  // the click a visible effect even when the numbers don't change.
  const setBusy = (busy: boolean): void => {
    claude.root.classList.toggle("usage-chip-busy", busy);
    codex.root.classList.toggle("usage-chip-busy", busy);
  };

  const onChipClick = (): void => {
    void load();
  };
  const claude = createChip(host, "claude", claudeGlyphSvg(), onChipClick);
  const codex = createChip(host, "codex", codexGlyphSvg(), onChipClick);

  const startTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
  };

  const onVisibilityChange = (): void => {
    if (!document.hidden) void load();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  void load();
  startTimer();

  return {
    refresh: () => load(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      host.replaceChildren();
    },
  };
}

function createChip(
  host: HTMLElement,
  provider: "claude" | "codex",
  glyph: SVGSVGElement,
  onClick: () => void,
): ChipHandle {
  const root = document.createElement("button");
  root.type = "button";
  root.className = `usage-chip usage-chip-${provider}`;
  root.title = "Click to refresh usage";
  root.setAttribute("aria-label", `${provider} usage — click to refresh`);
  root.addEventListener("click", onClick);

  const iconWrap = document.createElement("span");
  iconWrap.className = "usage-chip-icon";
  iconWrap.append(glyph);

  const bar = document.createElement("span");
  bar.className = "usage-chip-bar";
  const fill = document.createElement("span");
  fill.className = "usage-chip-bar-fill";
  fill.style.width = "0%";
  bar.append(fill);

  const text = document.createElement("span");
  text.className = "usage-chip-text";
  text.textContent = "—";

  root.append(iconWrap, bar, text);
  host.append(root);

  const setState = (state: ChipState, tooltip: string): void => {
    root.title = tooltip;
    const session = clampPercent(state.session);
    const weekly = clampPercent(state.weekly);
    // The bar always tracks the "primary" metric for the chip: the session
    // window when both are shown, or the weekly window when it's the only
    // one on display.
    const primary = state.layout === "weekly-only" ? weekly : session;
    fill.style.width = primary === null ? "0%" : `${primary}%`;
    const critical = (session ?? 0) >= 90 || (weekly ?? 0) >= 90;
    const warning = !critical && ((session ?? 0) >= 75 || (weekly ?? 0) >= 75);
    root.classList.toggle("usage-chip-critical", critical);
    root.classList.toggle("usage-chip-warning", warning);
    text.replaceChildren();
    if (state.layout === "weekly-only") {
      text.append(percentSpan(weekly, "wk"));
    } else {
      text.append(percentSpan(session, "5h"));
      text.append(document.createTextNode(" · "));
      text.append(percentSpan(weekly, "wk"));
    }
  };

  return { root, fill, text, setState };
}

function percentSpan(percent: number | null, unit: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "usage-chip-metric";
  const value = document.createElement("span");
  value.className = "usage-chip-metric-value";
  value.textContent = percent === null ? "—" : `${Math.round(percent)}%`;
  const label = document.createElement("em");
  label.className = "usage-chip-metric-unit";
  label.textContent = unit;
  wrap.append(value, document.createTextNode(" "), label);
  return wrap;
}

function render(claude: ChipHandle, codex: ChipHandle, report: UsageReport): void {
  const claudeState = pickClaude(report);
  const codexState = pickCodex(report);
  claude.setState(claudeState.state, claudeState.tooltip);
  codex.setState(codexState.state, codexState.tooltip);
}

interface Pick {
  state: ChipState;
  tooltip: string;
}

function pickClaude(report: UsageReport): Pick {
  const auth = report.claudeAuthoritative;
  if (auth) {
    const session = auth.session?.usedPercent ?? null;
    const weekly = auth.weekly?.usedPercent ?? null;
    const suffix = auth.session?.resetsAt
      ? resetSuffix(auth.session.resetsAt, report.nowSeconds)
      : null;
    return {
      state: { session, weekly, layout: "session-and-weekly" },
      tooltip:
        `Claude · 5h ${fmt(session)} · weekly ${fmt(weekly)}` + (suffix ? ` · ${suffix}` : ""),
    };
  }
  const block = report.claudeBlock;
  if (!block) {
    return {
      state: { session: null, weekly: null, layout: "session-and-weekly" },
      tooltip: "Claude — no session data yet",
    };
  }
  const cap = 30_000_000;
  const percent = cap > 0 ? Math.min(100, (block.tokens.total / cap) * 100) : 0;
  return {
    state: { session: percent, weekly: null, layout: "session-and-weekly" },
    tooltip: `Claude · 5h ${fmt(percent)} (approx.) · ${resetSuffix(block.endsAt, report.nowSeconds)}`,
  };
}

function pickCodex(report: UsageReport): Pick {
  const limits = report.codexLimits;
  if (!limits) {
    return {
      state: { session: null, weekly: null, layout: "weekly-only" },
      tooltip: "Codex — no rate-limit data yet",
    };
  }
  const weekly = pickWindow(limits.primary, limits.secondary, 60 * 24 * 7);
  const weeklyPct = weekly?.usedPercent ?? null;
  const suffix = weekly?.resetsAt ? resetSuffix(weekly.resetsAt, report.nowSeconds) : null;
  return {
    state: { session: null, weekly: weeklyPct, layout: "weekly-only" },
    tooltip: `Codex · weekly ${fmt(weeklyPct)}` + (suffix ? ` · ${suffix}` : ""),
  };
}

function pickWindow(
  primary: CodexRateWindow | null,
  secondary: CodexRateWindow | null,
  targetMinutes: number,
): CodexRateWindow | null {
  const candidates = [primary, secondary].filter(
    (w): w is CodexRateWindow => w !== null && w.windowMinutes !== null,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, current) => {
    const bestDelta = Math.abs((best.windowMinutes ?? 0) - targetMinutes);
    const currentDelta = Math.abs((current.windowMinutes ?? 0) - targetMinutes);
    return currentDelta < bestDelta ? current : best;
  });
}

function fmt(percent: number | null): string {
  return percent === null ? "—" : `${percent.toFixed(1)}%`;
}

function resetSuffix(resetsAt: number, now: number): string {
  const remaining = resetsAt - now;
  if (remaining <= 0) return "resets any moment";
  return `resets in ${formatDuration(remaining)}`;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  if (days >= 2) return `${days}d`;
  const hours = Math.floor(s / 3_600);
  if (hours >= 2) return `${hours}h ${Math.floor((s % 3_600) / 60)}m`;
  const minutes = Math.floor(s / 60);
  if (minutes >= 1) return `${minutes}m`;
  return `${s}s`;
}

function clampPercent(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

// Anthropic Claude burst: 8-pointed asterisk with concave sides, in the
// brand orange. Approximation — recognizable at 14px without licensed art.
function claudeGlyphSvg(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M12 1 L13.2 8.4 L18.4 3.2 L15.6 9.8 L22.8 9 L16 12 L22.8 15 L15.6 14.2 L18.4 20.8 L13.2 15.6 L12 23 L10.8 15.6 L5.6 20.8 L8.4 14.2 L1.2 15 L8 12 L1.2 9 L8.4 9.8 L5.6 3.2 L10.8 8.4 Z",
  );
  path.setAttribute("fill", "#d97706");
  svg.append(path);
  return svg;
}

// OpenAI/Codex mark: dark rounded square with a simplified stylized swirl.
// Approximation — kept as a dark chip that reads as "the other one" next
// to the orange Claude mark.
function codexGlyphSvg(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", "1");
  rect.setAttribute("y", "1");
  rect.setAttribute("width", "22");
  rect.setAttribute("height", "22");
  rect.setAttribute("rx", "11");
  rect.setAttribute("fill", "#111111");
  const inner = document.createElementNS("http://www.w3.org/2000/svg", "path");
  // Simplified OpenAI-style knot: three curves inside a circle.
  inner.setAttribute(
    "d",
    "M12 5.5 A 6.5 6.5 0 0 1 18.5 12 A 6.5 6.5 0 0 1 12 18.5 A 6.5 6.5 0 0 1 5.5 12 A 6.5 6.5 0 0 1 12 5.5 M12 8.2 A 3.8 3.8 0 0 0 8.2 12 M15.8 12 A 3.8 3.8 0 0 0 12 8.2 M12 15.8 A 3.8 3.8 0 0 0 15.8 12 M8.2 12 A 3.8 3.8 0 0 0 12 15.8",
  );
  inner.setAttribute("stroke", "#f3f3f3");
  inner.setAttribute("stroke-width", "1.1");
  inner.setAttribute("fill", "none");
  inner.setAttribute("stroke-linecap", "round");
  svg.append(rect, inner);
  return svg;
}
