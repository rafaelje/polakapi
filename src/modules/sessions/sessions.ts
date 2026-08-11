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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
    listEl.innerHTML = '<p class="sessions-empty">No sessions match these filters.</p>';
    renderDetail();
    return;
  }
  listEl.innerHTML = visible
    .map((session) => {
      const active = session.key === activeKey ? "is-active" : "";
      const path = session.cwd ?? "unknown directory";
      return `
        <button type="button" class="session-row ${active}" data-session-key="${escapeHtml(session.key)}">
          <div class="session-row-top">
            <span class="session-badge" data-agent="${session.agent}">${session.agent}</span>
            <span class="session-title">${escapeHtml(session.title)}</span>
          </div>
          <div class="session-meta">
            <span>${escapeHtml(sessionStatusLabel(session))}</span>
            <span>${escapeHtml(session.kind)}</span>
            <span>${escapeHtml(formatSessionTimestamp(session.updatedAt))}</span>
          </div>
          <div class="session-meta session-path" title="${escapeHtml(path)}">${escapeHtml(path)}</div>
        </button>`;
    })
    .join("");
  renderDetail();
}

function renderDetail(): void {
  if (!detailEl) return;
  const session = sessions.find((candidate) => candidate.key === activeKey);
  if (!session) {
    detailEl.innerHTML = '<p class="sessions-empty">Select a session to see its metadata.</p>';
    return;
  }
  const path = session.cwd ?? "Unknown directory";
  const resumeLabel = session.resumable ? "resume session" : "not resumable";
  detailEl.innerHTML = `
    <article class="sessions-detail-card">
      <header class="sessions-detail-heading">
        <div>
          <h1>${escapeHtml(session.title)}</h1>
          <span class="session-badge" data-agent="${session.agent}">${session.agent}</span>
        </div>
        <div class="sessions-detail-actions">
          <button type="button" class="sessions-btn sessions-btn-primary" id="sessions-resume" ${session.resumable ? "" : "disabled"}>
            ${resumeLabel}
          </button>
        </div>
      </header>
      <dl class="sessions-metadata">
        <dt>Status</dt><dd>${escapeHtml(sessionStatusLabel(session))}</dd>
        <dt>Kind</dt><dd>${escapeHtml(session.kind)}</dd>
        <dt>Working directory</dt><dd>${escapeHtml(path)}</dd>
        <dt>Last activity</dt><dd>${escapeHtml(formatSessionTimestamp(session.updatedAt))}</dd>
        <dt>Created</dt><dd>${escapeHtml(formatSessionTimestamp(session.createdAt))}</dd>
        <dt>Native id</dt><dd><code>${escapeHtml(session.nativeId)}</code></dd>
      </dl>
    </article>`;
  document.getElementById("sessions-resume")?.addEventListener("click", () => {
    void resumeSession(session);
  });
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
    if (detailEl) {
      detailEl.insertAdjacentHTML(
        "beforeend",
        `<p class="sessions-error">Could not resume session: ${escapeHtml(String(error))}</p>`,
      );
    }
  } finally {
    renderDetail();
  }
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
    if (listEl) listEl.innerHTML = '<p class="sessions-empty">Could not load sessions.</p>';
    if (detailEl) {
      detailEl.innerHTML = `<p class="sessions-empty sessions-error">${escapeHtml(String(error))}</p>`;
    }
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
