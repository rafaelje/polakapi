import { invoke } from "../../shared/tauri/invoke";
import {
  contextBar,
  contextLevel,
  contextPercent,
  fileSummary,
  formatCost,
  formatCpu,
  formatRam,
  formatTokens,
  formatUptime,
  groupByProject,
  shortModel,
  toolSummary,
} from "./format";
import type { AgentContextReport, ContextGroup, ContextRow, PaneContext, PaneQuery } from "./types";
import type { ProjectId } from "../workspaces/state/types";

// Live "what is each agent holding" panel for the right sidebar. Polls the
// Rust `agent_context` command for every live pane and renders one block per
// project. Panes whose CLI keeps no local transcript still get their process
// stats, so the panel never shows a blank row.

const POLL_MS = 4_000;

/** Structural view of TerminalRouter, so the panel stays unit-testable. */
export interface ContextPaneSource {
  livePanes(): Array<{
    paneId: string;
    projectId: ProjectId;
    cliId?: string;
    lastActivityAt: number;
    cwd?: string;
    title?: string;
    index: number;
  }>;
  on(listener: (event: { type: string }) => void): () => void;
}

export interface AgentContextPanelOptions {
  host: HTMLElement;
  source: ContextPaneSource;
  /** Project id -> display name, and the path used as the pane's cwd fallback. */
  getProjects(): ReadonlyMap<ProjectId, { name: string; path: string }>;
  pollMs?: number;
}

export interface AgentContextPanelHandle {
  refresh(): Promise<void>;
  dispose(): void;
}

interface PanelDom {
  rootEl: HTMLElement;
  caretEl: HTMLElement;
  countEl: HTMLElement;
  bodyEl: HTMLElement;
}

export function mountAgentContextPanel(opts: AgentContextPanelOptions): AgentContextPanelHandle {
  const dom = buildDom(opts.host);
  let disposed = false;
  let loading = false;
  let collapsed = false;

  const onHeaderClick = (): void => {
    collapsed = !collapsed;
    dom.rootEl.dataset.collapsed = String(collapsed);
    dom.caretEl.textContent = collapsed ? "▸" : "▾";
    if (!collapsed) void refresh();
  };
  dom.rootEl.querySelector(".agent-context-header")?.addEventListener("click", onHeaderClick);

  const refresh = async (): Promise<void> => {
    if (disposed || loading || collapsed) return;
    loading = true;
    try {
      const panes = opts.source.livePanes();
      const projects = opts.getProjects();
      const queries: PaneQuery[] = panes.map((pane) => ({
        ptyId: pane.paneId,
        cliId: pane.cliId,
        cwd: pane.cwd ?? projects.get(pane.projectId)?.path,
      }));
      const report =
        queries.length > 0
          ? await invoke<AgentContextReport>(
              "agent_context",
              { panes: queries },
              { toastOnError: false },
            )
          : null;
      if (disposed) return;
      const byPty = new Map((report?.panes ?? []).map((pane) => [pane.ptyId, pane]));
      const rows: ContextRow[] = panes.map((pane) => ({
        ptyId: pane.paneId,
        projectId: pane.projectId,
        label: pane.title ?? `${pane.cliId ?? "shell"} · pane ${pane.index}`,
        cliId: pane.cliId ?? "shell",
        lastActivityAt: pane.lastActivityAt,
        context: byPty.get(pane.paneId) ?? null,
      }));
      const names = new Map([...projects].map(([id, project]) => [id, project.name] as const));
      render(dom, groupByProject(rows, names), rows.length);
    } catch {
      // A failed poll leaves the previous snapshot on screen rather than
      // blanking the panel; the next tick retries.
    } finally {
      loading = false;
    }
  };

  const unsubscribe = opts.source.on((event) => {
    if (event.type === "counts-changed") void refresh();
  });
  void refresh();
  const timer = setInterval(() => void refresh(), opts.pollMs ?? POLL_MS);

  return {
    refresh,
    dispose(): void {
      disposed = true;
      clearInterval(timer);
      unsubscribe();
      dom.rootEl.remove();
    },
  };
}

function buildDom(host: HTMLElement): PanelDom {
  const rootEl = document.createElement("div");
  rootEl.className = "agent-context";
  rootEl.dataset.collapsed = "false";

  const header = document.createElement("div");
  header.className = "agent-context-header";

  const caretEl = document.createElement("span");
  caretEl.className = "agent-context-caret";
  caretEl.textContent = "▾";

  const title = document.createElement("span");
  title.className = "agent-context-title";
  title.textContent = "context";

  const countEl = document.createElement("span");
  countEl.className = "agent-context-count";

  header.append(caretEl, title, countEl);

  const bodyEl = document.createElement("div");
  bodyEl.className = "agent-context-body";

  rootEl.append(header, bodyEl);
  host.replaceChildren(rootEl);
  return { rootEl, caretEl, countEl, bodyEl };
}

function render(dom: PanelDom, groups: ContextGroup[], paneCount: number): void {
  dom.countEl.textContent = paneCount === 1 ? "1 agent" : `${paneCount} agents`;
  if (groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "agent-context-empty";
    empty.textContent = "No live agents. Open a terminal to see its context here.";
    dom.bodyEl.replaceChildren(empty);
    return;
  }
  dom.bodyEl.replaceChildren(...groups.map(renderGroup));
}

function renderGroup(group: ContextGroup): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "agent-context-group";

  const name = document.createElement("div");
  name.className = "agent-context-group-name";
  const label = document.createElement("span");
  label.textContent = group.projectName;
  const count = document.createElement("span");
  count.textContent = String(group.rows.length);
  name.append(label, count);

  wrapper.append(name, ...group.rows.map(renderRow));
  return wrapper;
}

function renderRow(row: ContextRow): HTMLElement {
  const el = document.createElement("div");
  el.className = "agent-context-row";
  el.dataset.cli = row.cliId;

  const head = document.createElement("div");
  head.className = "agent-context-row-head";
  const dot = document.createElement("span");
  dot.className = "agent-context-dot";
  const label = document.createElement("span");
  label.className = "agent-context-label";
  label.textContent = row.label;
  head.append(dot, label);

  const context = row.context;
  if (context?.model) {
    const model = document.createElement("span");
    model.className = "agent-context-model";
    model.textContent = shortModel(context.model) ?? "";
    head.append(model);
  }
  el.append(head);

  if (context && context.source !== "none") {
    el.append(...conversationLines(context));
  } else {
    const note = document.createElement("div");
    note.className = "agent-context-note";
    note.textContent = "no local transcript";
    el.append(note);
  }
  if (context) el.append(processLine(context));
  return el;
}

function conversationLines(context: PaneContext): HTMLElement[] {
  const lines: HTMLElement[] = [];
  const percent = contextPercent(context.contextTokens, context.contextLimit);

  const ctx = line("ctx");
  const bar = document.createElement("span");
  bar.className = "agent-context-bar";
  bar.dataset.level = contextLevel(percent);
  bar.textContent = contextBar(percent);
  const amount = value(
    `${formatTokens(context.contextTokens)}/${formatTokens(context.contextLimit)} (${percent}%)`,
  );
  ctx.append(bar, amount);
  lines.push(ctx);

  const cost = formatCost(context.costUsd);
  const turns = `${context.turns} turn${context.turns === 1 ? "" : "s"}`;
  const io = line("i/o");
  io.append(
    value(
      [
        `${formatTokens(context.inputTokens)} in`,
        `${formatTokens(context.outputTokens)} out`,
        turns,
        cost,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  lines.push(io);

  const tools = toolSummary(context);
  if (tools) {
    const el = line("tools");
    el.append(value(tools));
    lines.push(el);
  }
  const files = fileSummary(context);
  if (files) {
    const el = line("files");
    el.append(value(files));
    lines.push(el);
  }
  return lines;
}

function processLine(context: PaneContext): HTMLElement {
  const el = line("proc");
  el.append(
    value(
      [
        formatRam(context.rssMb),
        `CPU ${formatCpu(context.cpuPercent)}`,
        `up ${formatUptime(context.uptimeSecs)}`,
      ].join("  "),
    ),
  );
  return el;
}

function line(key: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "agent-context-line";
  const keyEl = document.createElement("span");
  keyEl.className = "agent-context-key";
  keyEl.textContent = key;
  el.append(keyEl);
  return el;
}

function value(text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "agent-context-value";
  el.textContent = text;
  return el;
}
