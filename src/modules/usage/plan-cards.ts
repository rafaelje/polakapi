import { formatTokens } from "./aggregate";
import {
  CLAUDE_PLANS,
  claudePlan,
  type AuthoritativeWindow,
  type ClaudeAuthoritative,
  type ClaudeBlock,
  type ClaudePlanTier,
  type CodexRateLimits,
  type CodexRateWindow,
  type UsageReport,
} from "./types";

// The two large plan-status cards at the top of the usage panel:
//   - Claude: authoritative from the Claude usage endpoint when we can
//     reach it, otherwise a local 5-hour block estimate against a
//     user-selected plan cap.
//   - Codex: always authoritative from the JSONL rate_limits snapshot.
//
// The countdown labels tick every second in the panel; they read the
// data-role attribute set here to update the DOM in place without rebuilding
// the entire card. Keep the role slugs stable across renders.

export function claudeAuthoritativeCard(data: ClaudeAuthoritative, now: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "usage-plan-card usage-plan-claude";

  const head = document.createElement("div");
  head.className = "usage-plan-head";
  const label = document.createElement("div");
  label.className = "usage-plan-label";
  label.textContent = "Claude Code — authoritative";
  const badge = document.createElement("span");
  badge.className = "usage-plan-badge";
  badge.textContent = "/usage";
  head.append(label, badge);
  card.append(head);

  if (data.session) {
    card.append(
      authoritativeWindowRow("Current session (5h)", data.session, now, "claude-session"),
    );
  }
  if (data.weekly) {
    card.append(authoritativeWindowRow("Weekly (all models)", data.weekly, now, "claude-weekly"));
  }
  if (data.fableWeekly) {
    card.append(authoritativeWindowRow("Weekly (Fable)", data.fableWeekly, now, "claude-fable"));
  }

  const note = document.createElement("div");
  note.className = "usage-plan-note";
  note.textContent = "Live authoritative snapshot — matches Claude /usage.";
  card.append(note);

  return card;
}

function authoritativeWindowRow(
  title: string,
  window: AuthoritativeWindow,
  now: number,
  role: string,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "usage-plan-window";

  const head = document.createElement("div");
  head.className = "usage-plan-window-head";
  const label = document.createElement("span");
  label.className = "usage-plan-window-label";
  label.textContent = title;
  const percent = clampPercent(window.usedPercent);
  const value = document.createElement("span");
  value.className = "usage-plan-primary";
  value.textContent = `${percent.toFixed(1)}% used`;
  head.append(label, value);
  wrap.append(head);

  wrap.append(progressBar(percent, "usage-bar-claude"));

  const meta = document.createElement("div");
  meta.className = "usage-plan-meta";
  const remaining = document.createElement("span");
  remaining.className = "usage-plan-secondary";
  remaining.textContent = `${(100 - percent).toFixed(1)}% remaining`;
  const reset = document.createElement("span");
  reset.className = "usage-plan-secondary usage-countdown";
  reset.dataset.role = `${role}-countdown`;
  reset.textContent = authoritativeResetText(window, now);
  meta.append(remaining, reset);
  wrap.append(meta);
  return wrap;
}

export function authoritativeResetText(window: AuthoritativeWindow, now: number): string {
  if (!window.resetsAt) return "Resets: unknown";
  const remaining = window.resetsAt - now;
  if (remaining <= 0) return "Resets any moment now";
  return `Resets in ${formatDuration(remaining)}`;
}

export function claudePlanCard(tier: ClaudePlanTier, report: UsageReport): HTMLElement {
  const plan = claudePlan(tier);
  const block: ClaudeBlock | null = report.claudeBlock;
  const usedTokens = block?.tokens.total ?? 0;
  const cap = plan.blockTokenCap;
  const percent = cap > 0 ? Math.min(100, (usedTokens / cap) * 100) : 0;

  const card = document.createElement("div");
  card.className = "usage-plan-card usage-plan-claude";

  const head = document.createElement("div");
  head.className = "usage-plan-head";
  const label = document.createElement("div");
  label.className = "usage-plan-label";
  label.textContent = "Claude Code — 5h block";
  head.append(label, planSelector(tier));
  card.append(head);

  card.append(progressBar(percent, "usage-bar-claude"));

  const meta = document.createElement("div");
  meta.className = "usage-plan-meta";
  const left = document.createElement("span");
  left.className = "usage-plan-primary";
  left.textContent = `${formatTokens(usedTokens)} / ${formatTokens(cap)} (${percent.toFixed(1)}%)`;
  const right = document.createElement("span");
  right.className = "usage-plan-secondary usage-countdown";
  right.dataset.role = "claude-countdown";
  right.textContent = claudeCountdownText(block, report.nowSeconds);
  meta.append(left, right);
  card.append(meta);

  const note = document.createElement("div");
  note.className = "usage-plan-note";
  note.textContent = `Cap: ${plan.label} ${plan.price}/mo · approximation — sign in to Claude Code for authoritative numbers`;
  card.append(note);

  return card;
}

export function codexPlanCard(report: UsageReport): HTMLElement {
  const card = document.createElement("div");
  card.className = "usage-plan-card usage-plan-codex";

  const head = document.createElement("div");
  head.className = "usage-plan-head";
  const label = document.createElement("div");
  label.className = "usage-plan-label";
  const isLive = report.codexLimits?.source === "live";
  label.textContent = isLive ? "Codex CLI — authoritative" : "Codex CLI — snapshot";
  const badge = document.createElement("span");
  badge.className = "usage-plan-badge";
  badge.textContent = codexPlanLabel(report.codexLimits);
  head.append(label, badge);
  card.append(head);

  if (!report.codexLimits) {
    const empty = document.createElement("div");
    empty.className = "usage-plan-empty";
    empty.textContent =
      "No rate-limit data found — sign in to Codex CLI or open a session so it records a snapshot.";
    card.append(empty);
    return card;
  }

  if (report.codexLimits.primary) {
    card.append(codexWindowRow(report.codexLimits.primary, report.nowSeconds, "primary"));
  }
  if (report.codexLimits.secondary) {
    card.append(codexWindowRow(report.codexLimits.secondary, report.nowSeconds, "secondary"));
  }

  const note = document.createElement("div");
  note.className = "usage-plan-note";
  if (isLive) {
    note.textContent = "Live authoritative snapshot — matches Codex /status.";
  } else {
    const capturedAt = report.codexLimits.capturedAt;
    note.textContent = capturedAt
      ? `Snapshot from JSONL · ${capturedAt}`
      : "Snapshot from JSONL · time unknown";
  }
  card.append(note);

  return card;
}

function codexWindowRow(
  window: CodexRateWindow,
  now: number,
  role: "primary" | "secondary",
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "usage-plan-window";

  const head = document.createElement("div");
  head.className = "usage-plan-window-head";
  const label = document.createElement("span");
  label.className = "usage-plan-window-label";
  label.textContent = windowLabel(window);
  const percent = clampPercent(window.usedPercent);
  const percentText = document.createElement("span");
  percentText.className = "usage-plan-primary";
  percentText.textContent = `${percent.toFixed(1)}% used`;
  head.append(label, percentText);
  wrap.append(head);

  wrap.append(progressBar(percent, "usage-bar-codex"));

  const meta = document.createElement("div");
  meta.className = "usage-plan-meta";
  const remainingPct = document.createElement("span");
  remainingPct.className = "usage-plan-secondary";
  remainingPct.textContent = `${(100 - percent).toFixed(1)}% remaining`;
  const reset = document.createElement("span");
  reset.className = "usage-plan-secondary usage-countdown";
  reset.dataset.role = `codex-${role}-countdown`;
  reset.textContent = codexResetText(window, now);
  meta.append(remainingPct, reset);
  wrap.append(meta);

  return wrap;
}

function planSelector(current: ClaudePlanTier): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "usage-plan-selector";
  const caption = document.createElement("span");
  caption.className = "usage-plan-selector-label";
  caption.textContent = "Plan";
  const select = document.createElement("select");
  select.className = "usage-plan-select";
  for (const plan of CLAUDE_PLANS) {
    const option = document.createElement("option");
    option.value = plan.id;
    option.textContent = `${plan.label} · ${plan.price}`;
    if (plan.id === current) option.selected = true;
    select.append(option);
  }
  select.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value as ClaudePlanTier;
    wrap.dispatchEvent(
      new CustomEvent<ClaudePlanTier>("usage-plan-change", { detail: value, bubbles: true }),
    );
  });
  wrap.append(caption, select);
  return wrap;
}

function progressBar(percent: number, extraClass: string): HTMLElement {
  const track = document.createElement("div");
  track.className = `usage-bar ${extraClass}`;
  const fill = document.createElement("div");
  fill.className = "usage-bar-fill";
  const pct = clampPercent(percent);
  fill.style.width = `${pct}%`;
  if (pct >= 90) fill.classList.add("critical");
  else if (pct >= 75) fill.classList.add("warning");
  track.append(fill);
  return track;
}

function windowLabel(window: CodexRateWindow): string {
  if (!window.windowMinutes) return "Window";
  const minutes = window.windowMinutes;
  if (minutes >= 60 * 24 * 7 - 60) return "Weekly window";
  if (minutes >= 60 * 24 - 30) return `${Math.round(minutes / (60 * 24))}-day window`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h window`;
  return `${minutes}m window`;
}

function codexPlanLabel(limits: CodexRateLimits | null): string {
  if (!limits) return "unknown";
  const raw = limits.planType ?? "";
  const nice: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro (lite)",
    business: "Business",
    enterprise: "Enterprise",
    team: "Team",
  };
  return nice[raw] ?? (raw || "detected");
}

export function claudeCountdownText(block: ClaudeBlock | null, now: number): string {
  if (!block) return "No activity in the last 5h";
  const remaining = block.endsAt - now;
  if (remaining <= 0) return "Block expired — next message opens a new one";
  return `${formatDuration(remaining)} left in block`;
}

export function codexResetText(window: CodexRateWindow, now: number): string {
  if (!window.resetsAt) return "Resets: unknown";
  const remaining = window.resetsAt - now;
  if (remaining <= 0) return "Resets any moment now";
  return `Resets in ${formatDuration(remaining)}`;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  if (days >= 2) return `${days}d`;
  const hours = Math.floor(s / 3_600);
  if (hours >= 2) return `${hours}h ${Math.floor((s % 3_600) / 60)}m`;
  const minutes = Math.floor(s / 60);
  if (minutes >= 1) return `${minutes}m ${s % 60}s`;
  return `${s}s`;
}
