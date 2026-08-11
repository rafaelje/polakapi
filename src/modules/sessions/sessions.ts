import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AGENT_SESSION_RESUME_EVENT, toResumeRequest } from "./resume";
import {
  filterSessions,
  formatSessionTimestamp,
  sessionStatusLabel,
  type SessionFilters,
} from "./sessions-model";
import type { AgentId, AgentSession, AgentSessionsResult } from "./types";

const listEl = document.getElementById("sessions-list");
const detailEl = document.getElementById("sessions-detail");
const warningsEl = document.getElementById("sessions-warnings");
const counterEl = document.getElementById("sessions-counter");
const searchEl = document.getElementById("sessions-search");
const agentEl = document.getElementById("sessions-agent");
const kindEl = document.getElementById("sessions-kind");
const archivedEl = document.getElementById("sessions-include-archived");
const refreshEl = document.getElementById("sessions-refresh");

let sessions: AgentSession[] = [];
let activeKey: string | null = null;
let loading = false;
let filters: SessionFilters = {
  needle: "",
  agent: "all",
  kind: "all",
  includeArchived: false,
};

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderMessage(container: HTMLElement, message: string, error = false): void {
  const className = error ? "sessions-empty sessions-error" : "sessions-empty";
  container.replaceChildren(makeElement("p", className, message));
}

function createBadge(session: AgentSession): HTMLSpanElement {
  const badge = makeElement("span", "session-badge", session.agent);
  badge.dataset.agent = session.agent;
  return badge;
}

function createMeta(values: string[], className = "session-meta"): HTMLDivElement {
  const meta = makeElement("div", className);
  meta.append(...values.map((value) => makeElement("span", undefined, value)));
  return meta;
}

function createSessionRow(session: AgentSession): HTMLButtonElement {
  const row = makeElement("button", `session-row${session.key === activeKey ? " is-active" : ""}`);
  row.type = "button";
  row.dataset.sessionKey = session.key;

  const top = makeElement("div", "session-row-top");
  top.append(createBadge(session), makeElement("span", "session-title", session.title));
  const meta = createMeta([
    sessionStatusLabel(session),
    session.kind,
    formatSessionTimestamp(session.updatedAt),
  ]);
  const path = session.cwd ?? "unknown directory";
  const pathEl = makeElement("div", "session-meta session-path", path);
  pathEl.title = path;
  row.append(top, meta, pathEl);
  return row;
}

function appendMetadata(list: HTMLDListElement, label: string, value: string, code = false): void {
  const description = makeElement("dd");
  description.append(code ? makeElement("code", undefined, value) : value);
  list.append(makeElement("dt", undefined, label), description);
}

function renderWarnings(result: AgentSessionsResult): void {
  if (!warningsEl) return;
  if (result.warnings.length === 0) {
    warningsEl.hidden = true;
    warningsEl.textContent = "";
    return;
  }
  warningsEl.hidden = false;
  warningsEl.textContent = result.warnings
    .map((warning) => `${warning.agent}: ${warning.message}`)
    .join(" · ");
}

function visibleSessions(): AgentSession[] {
  return filterSessions(sessions, filters);
}

function renderList(): void {
  if (!listEl) return;
  const visible = visibleSessions();
  if (activeKey && !visible.some((session) => session.key === activeKey)) activeKey = null;
  activeKey ??= visible[0]?.key ?? null;
  if (counterEl) {
    counterEl.textContent =
      visible.length === sessions.length
        ? `${sessions.length} sessions`
        : `${visible.length} of ${sessions.length} sessions`;
  }
  if (visible.length === 0) {
    renderMessage(listEl, "No sessions match these filters.");
    renderDetail();
    return;
  }
  listEl.replaceChildren(...visible.map(createSessionRow));
  renderDetail();
}

function renderDetail(): void {
  if (!detailEl) return;
  const session = sessions.find((candidate) => candidate.key === activeKey);
  if (!session) {
    renderMessage(detailEl, "Select a session to see its metadata.");
    return;
  }

  const article = makeElement("article", "sessions-detail-card");
  const header = makeElement("header", "sessions-detail-heading");
  const identity = makeElement("div");
  identity.append(makeElement("h1", undefined, session.title), createBadge(session));

  const actions = makeElement("div", "sessions-detail-actions");
  const resumeButton = makeElement(
    "button",
    "sessions-btn sessions-btn-primary",
    session.resumable ? "resume session" : "not resumable",
  );
  resumeButton.type = "button";
  resumeButton.id = "sessions-resume";
  resumeButton.disabled = !session.resumable;
  resumeButton.addEventListener("click", () => void resumeSession(session));
  actions.append(resumeButton);
  header.append(identity, actions);

  const metadata = makeElement("dl", "sessions-metadata");
  const path = session.cwd ?? "Unknown directory";
  appendMetadata(metadata, "Status", sessionStatusLabel(session));
  appendMetadata(metadata, "Kind", session.kind);
  appendMetadata(metadata, "Working directory", path);
  appendMetadata(metadata, "Last activity", formatSessionTimestamp(session.updatedAt));
  appendMetadata(metadata, "Created", formatSessionTimestamp(session.createdAt));
  appendMetadata(metadata, "Native id", session.nativeId, true);
  article.append(header, metadata);
  detailEl.replaceChildren(article);
}

async function resumeSession(session: AgentSession): Promise<void> {
  if (!session.resumable) return;
  const button = document.getElementById("sessions-resume");
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
    button.textContent = "opening…";
  }
  try {
    await emitTo("main", AGENT_SESSION_RESUME_EVENT, toResumeRequest(session));
  } catch (error) {
    console.error("Could not emit session resume request", error);
    renderDetail();
    if (detailEl) {
      detailEl.append(
        makeElement("p", "sessions-error", `Could not resume session: ${String(error)}`),
      );
    }
    return;
  }
  renderDetail();
}

async function refresh(): Promise<void> {
  if (loading) return;
  loading = true;
  if (refreshEl instanceof HTMLButtonElement) refreshEl.disabled = true;
  if (counterEl) counterEl.textContent = "loading…";
  try {
    const result = await invoke<AgentSessionsResult>("agent_list_sessions");
    sessions = result.sessions;
    renderWarnings(result);
    renderList();
  } catch (error) {
    console.error("Session discovery failed", error);
    if (counterEl) counterEl.textContent = "unavailable";
    if (listEl) renderMessage(listEl, "Could not load sessions.");
    if (detailEl) renderMessage(detailEl, String(error), true);
  } finally {
    loading = false;
    if (refreshEl instanceof HTMLButtonElement) refreshEl.disabled = false;
  }
}

function syncFilters(): void {
  filters = {
    needle: searchEl instanceof HTMLInputElement ? searchEl.value : "",
    agent: agentEl instanceof HTMLSelectElement ? (agentEl.value as AgentId | "all") : "all",
    kind: kindEl instanceof HTMLSelectElement ? kindEl.value : "all",
    includeArchived: archivedEl instanceof HTMLInputElement && archivedEl.checked,
  };
  renderList();
}

function wire(): void {
  listEl?.addEventListener("click", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const row = event.target.closest<HTMLElement>("[data-session-key]");
    if (!row?.dataset.sessionKey) return;
    activeKey = row.dataset.sessionKey;
    renderList();
  });
  searchEl?.addEventListener("input", syncFilters);
  agentEl?.addEventListener("change", syncFilters);
  kindEl?.addEventListener("change", syncFilters);
  archivedEl?.addEventListener("change", syncFilters);
  refreshEl?.addEventListener("click", () => void refresh());
  const currentWindow = getCurrentWindow();
  void currentWindow.onFocusChanged(({ payload: focused }) => {
    if (focused) void refresh();
  });
}

wire();
void refresh();
