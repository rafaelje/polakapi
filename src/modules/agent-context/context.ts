import { invoke } from "@tauri-apps/api/core";
import {
  breakdownRows,
  contextBar,
  contextLabel,
  contextLevel,
  contextPercent,
  formatBytes,
  formatClock,
  formatCpu,
  formatRam,
  formatTokens,
  formatUptime,
  isSortMode,
  kindLabel,
  shortModel,
  sortEntries,
} from "./format";
import type {
  AgentSummary,
  ContextBreakdown,
  ContextDetail,
  ContextEntry,
  EntryKind,
  ProcessStats,
  SearchHit,
  SortMode,
} from "./types";

// The /context window. Left: every pane running an agent CLI. Right: what that
// agent currently holds in its context — first what occupies it, then the
// content itself, readable entry by entry.

const listEl = document.getElementById("ctx-list");
const detailEl = document.getElementById("ctx-detail");
const counterEl = document.getElementById("ctx-counter");
const refreshEl = document.getElementById("ctx-refresh");
const searchEl = document.getElementById("ctx-search");
const sortEl = document.getElementById("ctx-sort");

type Filter = "all" | "instructions" | "files" | "tools" | "messages";

const FILTERS: Array<{ key: Filter; label: string; kinds: EntryKind[] }> = [
  { key: "all", label: "everything", kinds: [] },
  { key: "instructions", label: "instructions", kinds: ["instructions"] },
  { key: "files", label: "files", kinds: ["file-content"] },
  { key: "tools", label: "tools", kinds: ["tool-call", "tool-output"] },
  { key: "messages", label: "messages", kinds: ["user-prompt", "assistant-text", "thinking"] },
];

let agents: AgentSummary[] = [];
let activePtyId: string | null = null;
let detail: ContextDetail | null = null;
let filter: Filter = "all";
let sortMode: SortMode = "oldest";
let pattern = "";
/** null when no search is active, distinct from an empty result set. */
let hits: Map<number, SearchHit> | null = null;
let searchError: string | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
const expanded = new Map<number, string>();

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function message(host: HTMLElement, text: string, error = false): void {
  host.replaceChildren(el("p", error ? "ctx-empty ctx-error" : "ctx-empty", text));
}

async function loadAgents(): Promise<void> {
  if (!listEl) return;
  try {
    agents = await invoke<AgentSummary[]>("agent_context_list");
  } catch (error) {
    message(listEl, `Could not list running agents: ${String(error)}`, true);
    return;
  }
  if (counterEl) {
    counterEl.textContent =
      agents.length === 1 ? "1 agent running" : `${agents.length} agents running`;
  }
  renderList();
  if (activePtyId && !agents.some((agent) => agent.ptyId === activePtyId)) {
    activePtyId = null;
    detail = null;
    if (detailEl) message(detailEl, "That agent is no longer running.");
  }
}

function renderList(): void {
  if (!listEl) return;
  if (agents.length === 0) {
    message(
      listEl,
      "No agent CLI is running. Start claude, codex, opencode or cursor-agent in a terminal pane.",
    );
    return;
  }
  const groups = new Map<string, AgentSummary[]>();
  for (const agent of agents) {
    const key = agent.project ?? "unknown project";
    const bucket = groups.get(key);
    if (bucket) bucket.push(agent);
    else groups.set(key, [agent]);
  }
  const nodes: HTMLElement[] = [];
  for (const [project, members] of groups) {
    nodes.push(el("div", "ctx-group", project));
    nodes.push(...members.map(agentRow));
  }
  listEl.replaceChildren(...nodes);
}

function agentRow(agent: AgentSummary): HTMLButtonElement {
  const row = el("button", `ctx-row${agent.ptyId === activePtyId ? " is-active" : ""}`);
  row.type = "button";
  row.dataset.ptyId = agent.ptyId;

  const top = el("div", "ctx-row-top");
  const badge = el("span", "ctx-badge", agent.cli);
  badge.dataset.cli = agent.cli;
  top.append(badge, el("span", "ctx-row-model", shortModel(agent.model) ?? "unknown model"));

  const meter = el("div", "ctx-row-meter");
  if (agent.contextLimit > 0) {
    const percent = contextPercent(agent.contextTokens, agent.contextLimit);
    const bar = el("span", "ctx-bar", contextBar(percent));
    bar.dataset.level = contextLevel(percent);
    meter.append(bar);
  }
  meter.append(el("span", "ctx-muted", contextLabel(agent.contextTokens, agent.contextLimit)));

  row.append(top, meter);
  row.addEventListener("click", () => {
    void selectAgent(agent.ptyId);
  });
  return row;
}

async function selectAgent(ptyId: string): Promise<void> {
  activePtyId = ptyId;
  filter = "all";
  expanded.clear();
  // Entry ids are per-transcript, so a previous agent's hits would mis-point.
  hits = null;
  searchError = null;
  renderList();
  if (!detailEl) return;
  message(detailEl, "Reading context…");
  try {
    detail = await invoke<ContextDetail>("agent_context_detail", { ptyId });
  } catch (error) {
    message(detailEl, `Could not read that context: ${String(error)}`, true);
    return;
  }
  if (pattern.trim() !== "") {
    await runSearch();
    return;
  }
  renderDetail();
}

function renderDetail(): void {
  if (!detailEl || !detail) return;
  const { summary, note, entries } = detail;
  const nodes: HTMLElement[] = [detailHeader(summary)];

  if (note) {
    nodes.push(el("p", "ctx-note", note));
    detailEl.replaceChildren(...nodes);
    return;
  }

  nodes.push(breakdownSection(detail.breakdown));
  nodes.push(
    el(
      "p",
      "ctx-disclaimer",
      "Per-entry sizes are estimated from text length; the total above comes from the API. " +
        "After a compaction the earlier entries may no longer be in the model's window.",
    ),
  );
  nodes.push(filterBar());

  const found = hits;
  let visible = entries.filter(matchesFilter);
  if (found) visible = visible.filter((entry) => found.has(entry.id));
  visible = sortEntries(visible, sortMode);

  if (searchError) {
    nodes.push(el("p", "ctx-empty ctx-error", searchError));
  } else if (found) {
    const total = [...found.values()].reduce((sum, hit) => sum + hit.matches, 0);
    nodes.push(
      el(
        "p",
        "ctx-disclaimer",
        `${total} match${total === 1 ? "" : "es"} in ${found.size} entr${found.size === 1 ? "y" : "ies"}.`,
      ),
    );
  }

  if (visible.length === 0) {
    nodes.push(el("p", "ctx-empty", found ? "Nothing matches." : "Nothing in this category."));
  } else {
    const timeline = el("div", "ctx-timeline");
    timeline.append(...visible.map((entry) => entryRow(entry, found?.get(entry.id) ?? null)));
    nodes.push(timeline);
  }
  detailEl.replaceChildren(...nodes);
}

async function runSearch(): Promise<void> {
  if (!activePtyId || pattern.trim() === "") {
    hits = null;
    searchError = null;
    renderDetail();
    return;
  }
  try {
    const found = await invoke<SearchHit[]>("agent_context_search", {
      ptyId: activePtyId,
      pattern,
    });
    hits = new Map(found.map((hit) => [hit.entryId, hit]));
    searchError = null;
  } catch (error) {
    hits = null;
    searchError = String(error);
  }
  renderDetail();
}

function detailHeader(summary: AgentSummary): HTMLElement {
  const header = el("div", "ctx-detail-header");
  const title = el("div", "ctx-detail-title");
  const badge = el("span", "ctx-badge", summary.cli);
  badge.dataset.cli = summary.cli;
  title.append(
    badge,
    el("strong", undefined, summary.project ?? "unknown project"),
    el("span", "ctx-muted", shortModel(summary.model) ?? "unknown model"),
  );

  const meter = el("div", "ctx-detail-meter");
  if (summary.contextLimit > 0) {
    const percent = contextPercent(summary.contextTokens, summary.contextLimit);
    const bar = el("span", "ctx-bar", contextBar(percent, 20));
    bar.dataset.level = contextLevel(percent);
    meter.append(bar);
  }
  meter.append(el("span", "ctx-muted", contextLabel(summary.contextTokens, summary.contextLimit)));

  header.append(title, meter, processLine(summary.process));
  if (summary.cwd) header.append(el("div", "ctx-path", summary.cwd));
  return header;
}

function processLine(stats: ProcessStats): HTMLElement {
  const parts = [
    `RAM ${formatRam(stats.rssMb)}`,
    `CPU ${formatCpu(stats.cpuPercent)}`,
    `up ${formatUptime(stats.uptimeSecs)}`,
  ];
  if (stats.pid !== null) parts.push(`pid ${stats.pid}`);
  // CPU reads 0% until a second sample exists to diff against; "reload" gives it one.
  return el("div", "ctx-process", parts.join("  ·  "));
}

function breakdownSection(breakdown: ContextBreakdown): HTMLElement {
  const section = el("div", "ctx-breakdown");
  section.append(el("div", "ctx-section-title", "what occupies the context"));
  for (const row of breakdownRows(breakdown)) {
    const line = el("div", "ctx-breakdown-row");
    line.append(
      el("span", "ctx-breakdown-label", row.label),
      el("span", "ctx-bar ctx-bar-muted", contextBar(row.percent, 14)),
      el("span", "ctx-muted", `${formatTokens(row.tokens)} · ${row.percent}%`),
    );
    section.append(line);
  }
  return section;
}

function filterBar(): HTMLElement {
  const bar = el("div", "ctx-filters");
  for (const option of FILTERS) {
    const button = el(
      "button",
      `ctx-chip${filter === option.key ? " is-active" : ""}`,
      option.label,
    );
    button.type = "button";
    button.addEventListener("click", () => {
      filter = option.key;
      renderDetail();
    });
    bar.append(button);
  }
  return bar;
}

function matchesFilter(entry: ContextEntry): boolean {
  const option = FILTERS.find((candidate) => candidate.key === filter);
  if (!option || option.kinds.length === 0) return true;
  return option.kinds.includes(entry.kind);
}

function entryRow(entry: ContextEntry, hit: SearchHit | null): HTMLElement {
  const row = el("div", "ctx-entry");
  row.dataset.kind = entry.kind;

  const head = el("div", "ctx-entry-head");
  head.append(
    el("span", "ctx-entry-kind", kindLabel(entry.kind)),
    el("span", "ctx-entry-label", entry.label),
  );
  if (entry.detail) head.append(el("span", "ctx-entry-detail", entry.detail));
  head.append(
    el("span", "ctx-entry-size", `${formatTokens(entry.estTokens)} · ${formatBytes(entry.chars)}`),
  );
  const clock = formatClock(entry.timestamp);
  if (clock) head.append(el("span", "ctx-entry-time", clock));

  if (hit) {
    head.append(el("span", "ctx-entry-hits", `${hit.matches}×`));
  }

  const body = el("pre", "ctx-entry-body", expanded.get(entry.id) ?? entry.preview);

  row.append(head);
  // The match may sit past the preview cut, so show where it actually is.
  if (hit && !expanded.has(entry.id)) row.append(el("div", "ctx-snippet", hit.snippet));
  row.append(body);
  if (entry.truncated || expanded.has(entry.id)) {
    const toggle = el("button", "ctx-more", expanded.has(entry.id) ? "show less" : "read all");
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      void toggleEntry(entry, body, toggle);
    });
    row.append(toggle);
  }
  return row;
}

async function toggleEntry(
  entry: ContextEntry,
  body: HTMLElement,
  toggle: HTMLButtonElement,
): Promise<void> {
  if (expanded.has(entry.id)) {
    expanded.delete(entry.id);
    body.textContent = entry.preview;
    toggle.textContent = "read all";
    return;
  }
  if (!activePtyId) return;
  toggle.disabled = true;
  try {
    const full = await invoke<string | null>("agent_context_entry", {
      ptyId: activePtyId,
      entryId: entry.id,
    });
    if (full !== null) {
      expanded.set(entry.id, full);
      body.textContent = full;
      toggle.textContent = "show less";
    }
  } catch (error) {
    body.textContent = `Could not read this entry: ${String(error)}`;
  } finally {
    toggle.disabled = false;
  }
}

if (searchEl instanceof HTMLInputElement) {
  const input = searchEl;
  input.addEventListener("input", () => {
    pattern = input.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void runSearch(), 250);
  });
}

if (sortEl instanceof HTMLSelectElement) {
  const select = sortEl;
  select.addEventListener("change", () => {
    if (isSortMode(select.value)) {
      sortMode = select.value;
      renderDetail();
    }
  });
}

refreshEl?.addEventListener("click", () => {
  void loadAgents().then(() => {
    if (activePtyId) void selectAgent(activePtyId);
  });
});

void loadAgents();
