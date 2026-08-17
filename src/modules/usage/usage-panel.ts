import { invoke } from "../../shared/tauri/invoke";
import { loadLayout, queueSave } from "../../shared/persistence/store";
import { formatTokens, sumLastDays } from "./aggregate";
import {
  authoritativeResetText,
  claudeAuthoritativeCard,
  claudeCountdownText,
  claudePlanCard,
  codexPlanCard,
  codexResetText,
} from "./plan-cards";
import type {
  AuthoritativeWindow,
  ClaudePlanTier,
  DailyBucket,
  TokenTotals,
  UsageReport,
  UsageWarning,
} from "./types";

// The "usage" tab of the bottom panel. Two plan-status cards on top (Claude,
// Codex), then window totals (today/7d/30d/all) and a per-day breakdown.
// Data comes from the Rust `usage_summary` command; the plan-cards module
// owns the two cards' DOM.

export interface UsagePanelOptions {
  isVisible: () => boolean;
}

export interface UsagePanelHandle {
  activate(): void;
  refresh(): Promise<void>;
  dispose(): void;
}

interface RenderContext {
  root: HTMLElement;
  plans: HTMLElement;
  summary: HTMLElement;
  table: HTMLElement;
  status: HTMLElement;
  refreshButton: HTMLButtonElement;
}

interface PanelState {
  planTier: ClaudePlanTier;
  report: UsageReport | null;
}

export function mountUsagePanel(host: HTMLElement, opts: UsagePanelOptions): UsagePanelHandle {
  const ctx = buildLayout(host);
  const state: PanelState = { planTier: "pro", report: null };
  let disposed = false;
  let loaded = false;
  let loading = false;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  void loadLayout().then((layout) => {
    if (disposed) return;
    if (layout.claudePlanTier) {
      state.planTier = layout.claudePlanTier;
      if (state.report) renderReport(ctx, state);
    }
  });

  const load = async (): Promise<void> => {
    if (disposed || loading) return;
    loading = true;
    ctx.refreshButton.disabled = true;
    ctx.status.textContent = "Loading…";
    try {
      const report = await invoke<UsageReport>("usage_summary", undefined, {
        toastOnError: false,
      });
      if (disposed) return;
      loaded = true;
      state.report = report;
      renderReport(ctx, state);
      startCountdown();
    } catch (error) {
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.status.textContent = `Failed to load usage: ${message}`;
      ctx.plans.replaceChildren();
      ctx.summary.replaceChildren();
      ctx.table.replaceChildren();
    } finally {
      loading = false;
      ctx.refreshButton.disabled = false;
    }
  };

  const startCountdown = (): void => {
    if (countdownTimer) return;
    countdownTimer = setInterval(() => {
      if (disposed || !state.report) return;
      // Update only the countdown labels in place; a full re-render each
      // second would repaint the whole panel.
      updateCountdowns(ctx.plans, state.report);
    }, 1_000);
  };

  const stopCountdown = (): void => {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };

  const onRefreshClick = (): void => {
    void load();
  };
  ctx.refreshButton.addEventListener("click", onRefreshClick);

  const onPlanChange = (tier: ClaudePlanTier): void => {
    state.planTier = tier;
    queueSave({ claudePlanTier: tier });
    if (state.report) renderReport(ctx, state);
  };
  ctx.root.addEventListener("usage-plan-change", (event) => {
    onPlanChange((event as CustomEvent<ClaudePlanTier>).detail);
  });

  return {
    activate: () => {
      if (disposed) return;
      if (!opts.isVisible()) return;
      if (!loaded && !loading) {
        void load();
      } else if (loaded) {
        startCountdown();
      }
    },
    refresh: async () => {
      await load();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopCountdown();
      ctx.refreshButton.removeEventListener("click", onRefreshClick);
      host.replaceChildren();
    },
  };
}

function buildLayout(host: HTMLElement): RenderContext {
  host.replaceChildren();
  host.classList.add("usage-host");

  const root = document.createElement("div");
  root.className = "usage-panel";

  const header = document.createElement("div");
  header.className = "usage-header";
  const title = document.createElement("div");
  title.className = "usage-title";
  title.textContent = "Token usage (local)";
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "usage-refresh";
  refreshButton.textContent = "Refresh";
  header.append(title, refreshButton);

  const plans = document.createElement("div");
  plans.className = "usage-plans";

  const summary = document.createElement("div");
  summary.className = "usage-summary";

  const table = document.createElement("div");
  table.className = "usage-table";

  const status = document.createElement("div");
  status.className = "usage-status";
  status.textContent = "";

  root.append(header, plans, summary, status, table);
  host.append(root);

  return { root, plans, summary, table, status, refreshButton };
}

function renderReport(ctx: RenderContext, state: PanelState): void {
  const report = state.report;
  if (!report) return;
  ctx.plans.replaceChildren();
  if (report.claudeAuthoritative) {
    ctx.plans.append(claudeAuthoritativeCard(report.claudeAuthoritative, report.nowSeconds));
  } else {
    const card = claudePlanCard(state.planTier, report);
    const claudeWarning = report.warnings.find((w) => w.provider === "claude");
    if (claudeWarning) {
      const banner = document.createElement("div");
      banner.className = "usage-plan-note usage-plan-error";
      banner.textContent = `Authoritative fetch failed: ${claudeWarning.message}`;
      card.append(banner);
    }
    ctx.plans.append(card);
  }
  ctx.plans.append(codexPlanCard(report));
  renderSummary(ctx.summary, report);
  renderTable(ctx.table, report.daily);
  renderStatus(ctx.status, report);
}

function updateCountdowns(host: HTMLElement, report: UsageReport): void {
  const now = liveNowSeconds(report);
  const claude = host.querySelector<HTMLElement>("[data-role='claude-countdown']");
  if (claude) claude.textContent = claudeCountdownText(report.claudeBlock, now);
  if (report.claudeAuthoritative) {
    const pairs: [string, AuthoritativeWindow | null][] = [
      ["claude-session-countdown", report.claudeAuthoritative.session],
      ["claude-weekly-countdown", report.claudeAuthoritative.weekly],
      ["claude-fable-countdown", report.claudeAuthoritative.fableWeekly],
    ];
    for (const [role, window] of pairs) {
      if (!window) continue;
      const el = host.querySelector<HTMLElement>(`[data-role='${role}']`);
      if (el) el.textContent = authoritativeResetText(window, now);
    }
  }
  const codexPrimary = host.querySelector<HTMLElement>("[data-role='codex-primary-countdown']");
  if (codexPrimary && report.codexLimits?.primary) {
    codexPrimary.textContent = codexResetText(report.codexLimits.primary, now);
  }
  const codexSecondary = host.querySelector<HTMLElement>("[data-role='codex-secondary-countdown']");
  if (codexSecondary && report.codexLimits?.secondary) {
    codexSecondary.textContent = codexResetText(report.codexLimits.secondary, now);
  }
}

const fetchedAtByReport = new WeakMap<UsageReport, number>();

// The Rust command stamps `nowSeconds` at fetch time; we advance it locally
// so the countdown ticks without hitting the backend every second.
function liveNowSeconds(report: UsageReport): number {
  const cached = fetchedAtByReport.get(report);
  const stampedAt = cached ?? Math.floor(Date.now() / 1000);
  if (cached === undefined) fetchedAtByReport.set(report, stampedAt);
  const drift = Math.floor(Date.now() / 1000) - stampedAt;
  return report.nowSeconds + Math.max(0, drift);
}

function renderSummary(host: HTMLElement, report: UsageReport): void {
  host.replaceChildren();
  const nowMs = report.nowSeconds * 1000;
  const windows: { label: string; days: number }[] = [
    { label: "Today", days: 1 },
    { label: "7 days", days: 7 },
    { label: "30 days", days: 30 },
    { label: "All time", days: Number.POSITIVE_INFINITY },
  ];
  for (const window of windows) {
    const claude = sumLastDays(report.daily, window.days, (b) => b.claude, nowMs);
    const codex = sumLastDays(report.daily, window.days, (b) => b.codex, nowMs);
    host.append(summaryCard(window.label, claude, codex));
  }
}

function summaryCard(label: string, claude: TokenTotals, codex: TokenTotals): HTMLElement {
  const card = document.createElement("div");
  card.className = "usage-card";

  const heading = document.createElement("div");
  heading.className = "usage-card-label";
  heading.textContent = label;
  card.append(heading);

  card.append(providerRow("claude", claude));
  card.append(providerRow("codex", codex));

  return card;
}

function providerRow(provider: "claude" | "codex", totals: TokenTotals): HTMLElement {
  const row = document.createElement("div");
  row.className = `usage-card-row usage-provider-${provider}`;

  const name = document.createElement("span");
  name.className = "usage-provider";
  name.textContent = provider;

  const value = document.createElement("span");
  value.className = "usage-value";
  value.textContent = formatTokens(totals.total);
  value.title = tokensTitle(totals);

  row.append(name, value);
  return row;
}

function tokensTitle(totals: TokenTotals): string {
  return [
    `input ${totals.input.toLocaleString()}`,
    `output ${totals.output.toLocaleString()}`,
    `cache read ${totals.cacheRead.toLocaleString()}`,
    `cache write ${totals.cacheWrite.toLocaleString()}`,
    `reasoning ${totals.reasoning.toLocaleString()}`,
  ].join(" · ");
}

function renderTable(host: HTMLElement, daily: readonly DailyBucket[]): void {
  host.replaceChildren();
  if (daily.length === 0) {
    const empty = document.createElement("div");
    empty.className = "usage-empty";
    empty.textContent = "No local usage data found in ~/.claude or ~/.codex.";
    host.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "usage-daily";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Date", "Claude", "Codex", "Total"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const bucket of daily) {
    const row = document.createElement("tr");
    const date = document.createElement("td");
    date.textContent = bucket.date;

    const claude = tokenCell(bucket.claude);
    const codex = tokenCell(bucket.codex);
    const total = tokenCell({
      input: bucket.claude.input + bucket.codex.input,
      output: bucket.claude.output + bucket.codex.output,
      cacheRead: bucket.claude.cacheRead + bucket.codex.cacheRead,
      cacheWrite: bucket.claude.cacheWrite + bucket.codex.cacheWrite,
      reasoning: bucket.claude.reasoning + bucket.codex.reasoning,
      total: bucket.claude.total + bucket.codex.total,
    });

    row.append(date, claude, codex, total);
    tbody.append(row);
  }
  table.append(tbody);
  host.append(table);
}

function tokenCell(totals: TokenTotals): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.className = "usage-cell";
  cell.textContent = formatTokens(totals.total);
  cell.title = tokensTitle(totals);
  return cell;
}

function renderStatus(host: HTMLElement, report: UsageReport): void {
  const parts: string[] = [];
  if (report.daily.length === 0 && report.warnings.length === 0) {
    parts.push("No usage data yet — run Claude Code or Codex CLI first.");
  } else if (report.daily.length > 0) {
    parts.push(`${report.daily.length} day${report.daily.length === 1 ? "" : "s"} of history.`);
  }
  for (const warning of report.warnings) {
    parts.push(warningText(warning));
  }
  host.textContent = parts.join(" ");
}

function warningText(warning: UsageWarning): string {
  return `${warning.provider}: ${warning.message}`;
}
