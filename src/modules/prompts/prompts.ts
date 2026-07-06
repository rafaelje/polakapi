import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface SessionRow {
  id: number;
  ptyId: string;
  cli: string;
  cliSessionId: string | null;
  cwd: string | null;
  title: string | null;
  status: string;
  createdAt: number;
  closedAt: number | null;
  promptCount: number;
}

interface PromptListRow {
  id: number;
  sessionId: number;
  seq: number;
  userPreview: string;
  hasResponse: boolean;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  elapsedMs: number | null;
  error: string | null;
  createdAt: number;
}

interface PromptFullRow {
  id: number;
  sessionId: number;
  seq: number;
  userInput: string | null;
  responseText: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  elapsedMs: number | null;
  error: string | null;
  createdAt: number;
}

const sessionsEl = document.getElementById("prompts-sessions");
const detailEl = document.getElementById("prompts-detail");
const counterEl = document.getElementById("prompts-counter");
const filterEl = document.getElementById("prompts-filter");
const refreshBtn = document.getElementById("prompts-refresh");
const deleteBtn = document.getElementById("prompts-delete");
const selectAllEl = document.getElementById("prompts-select-all");

let sessions: SessionRow[] = [];
let activeSessionId: number | null = null;
let filterNeedle = "";
let selectedSessionIds = new Set<number>();

async function listSessions(): Promise<SessionRow[]> {
  return await invoke<SessionRow[]>("prompt_list_sessions");
}

async function listPrompts(sessionId: number): Promise<PromptListRow[]> {
  return await invoke<PromptListRow[]>("prompt_list_by_session", { sessionId });
}

async function getPrompt(id: number): Promise<PromptFullRow | null> {
  return await invoke<PromptFullRow | null>("prompt_get", { id });
}

async function searchPrompts(needle: string): Promise<PromptListRow[]> {
  return await invoke<PromptListRow[]>("prompt_search", { needle });
}

async function deleteSessions(sessionIds: number[]): Promise<number> {
  return await invoke<number>("prompt_delete_sessions", { sessionIds });
}

function cliBadge(cli: string): string {
  return `<span class="session-row-cli">${escapeHtml(cli)}</span>`;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${y}-${mo}-${da} ${h}:${mi}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pruneSelectedSessions(): void {
  const validIds = new Set(sessions.map((s) => s.id));
  for (const id of selectedSessionIds) {
    if (!validIds.has(id)) selectedSessionIds.delete(id);
  }
}

function updateBulkControls(): void {
  const selectedCount = selectedSessionIds.size;
  if (deleteBtn instanceof HTMLButtonElement) {
    deleteBtn.disabled = selectedCount === 0;
    deleteBtn.textContent = selectedCount === 0 ? "delete" : `delete ${selectedCount}`;
  }
  if (selectAllEl instanceof HTMLInputElement) {
    selectAllEl.disabled = sessions.length === 0;
    selectAllEl.checked = sessions.length > 0 && selectedCount === sessions.length;
    selectAllEl.indeterminate = selectedCount > 0 && selectedCount < sessions.length;
  }
  if (counterEl) {
    counterEl.textContent =
      selectedCount > 0
        ? `${sessions.length} sessions · ${selectedCount} selected`
        : `${sessions.length} sessions`;
  }
}

function renderSessions(): void {
  if (!sessionsEl) return;
  pruneSelectedSessions();
  if (sessions.length === 0) {
    sessionsEl.innerHTML =
      '<p class="prompts-empty">no sessions yet. run an AI CLI tab to populate.</p>';
    updateBulkControls();
    return;
  }
  sessionsEl.innerHTML = sessions
    .map((s) => {
      const active = s.id === activeSessionId ? "active" : "";
      const selected = selectedSessionIds.has(s.id) ? "selected" : "";
      const checked = selectedSessionIds.has(s.id) ? "checked" : "";
      const title = s.title?.trim() || "(untitled session)";
      return `
        <div class="session-row ${active} ${selected}" data-session-id="${s.id}">
          <label class="session-row-check" title="Select session">
            <input
              type="checkbox"
              class="session-row-select"
              data-session-id="${s.id}"
              aria-label="Select ${escapeHtml(title)}"
              ${checked}
            />
          </label>
          <div class="session-row-content">
            <div class="session-row-title">${escapeHtml(title)}</div>
            <div class="session-row-meta">
              ${cliBadge(s.cli)}
              <span>${s.promptCount} prompts</span>
              <span>${formatTimestamp(s.createdAt)}</span>
            </div>
          </div>
        </div>`;
    })
    .join("");
  updateBulkControls();
}

function renderDetail(prompts: PromptListRow[], fullById: Map<number, PromptFullRow>): void {
  if (!detailEl) return;
  if (prompts.length === 0) {
    detailEl.innerHTML = '<p class="prompts-empty">no prompts in this session.</p>';
    return;
  }
  detailEl.innerHTML = prompts
    .map((p) => {
      const full = fullById.get(p.id);
      const userInput = full?.userInput ?? p.userPreview;
      const responseText = full?.responseText;
      const responseBlock =
        responseText != null
          ? `<div class="prompt-response">${escapeHtml(responseText)}</div>`
          : `<div class="prompt-pending">response pending…</div>`;
      const tokens =
        p.tokensIn != null || p.tokensOut != null
          ? `<span>${p.tokensIn ?? "?"}→${p.tokensOut ?? "?"} tokens</span>`
          : "";
      const cost = p.costUsd != null ? `<span>$${p.costUsd.toFixed(4)}</span>` : "";
      const elapsed = p.elapsedMs != null ? `<span>${p.elapsedMs}ms</span>` : "";
      const error = p.error ? `<div class="prompt-error">${escapeHtml(p.error)}</div>` : "";
      return `
        <div class="prompt-card" data-prompt-id="${p.id}">
          <div class="prompt-card-header">
            <span class="prompt-seq">#${p.seq}</span>
            <span>${formatTimestamp(p.createdAt)}</span>
          </div>
          <div class="prompt-user">${escapeHtml(userInput ?? "")}</div>
          ${responseBlock}
          <div class="prompt-meta">${tokens}${cost}${elapsed}</div>
          ${error}
        </div>`;
    })
    .join("");
}

async function openSession(sessionId: number): Promise<void> {
  activeSessionId = sessionId;
  renderSessions();
  const prompts = await listPrompts(sessionId);
  const filtered =
    filterNeedle.trim().length > 0
      ? prompts.filter(
          (p) =>
            p.userPreview.toLowerCase().includes(filterNeedle.toLowerCase()) ||
            (p.error?.toLowerCase().includes(filterNeedle.toLowerCase()) ?? false),
        )
      : prompts;
  const fullById = new Map<number, PromptFullRow>();
  for (const p of filtered) {
    const full = await getPrompt(p.id);
    if (full) fullById.set(p.id, full);
  }
  renderDetail(filtered, fullById);
}

async function runSearch(): Promise<void> {
  const needle = filterNeedle.trim();
  if (needle.length === 0) {
    await refresh();
    return;
  }
  const hits = await searchPrompts(needle);
  if (detailEl) {
    const fullById = new Map<number, PromptFullRow>();
    for (const p of hits) {
      const full = await getPrompt(p.id);
      if (full) fullById.set(p.id, full);
    }
    activeSessionId = null;
    renderSessions();
    if (hits.length === 0) {
      detailEl.innerHTML = `<p class="prompts-empty">no prompts match "${escapeHtml(needle)}".</p>`;
    } else {
      detailEl.innerHTML = `<p class="prompts-sub">${hits.length} matches across sessions.</p>`;
      detailEl.insertAdjacentHTML(
        "beforeend",
        hits
          .map((p) => {
            const full = fullById.get(p.id);
            const userInput = full?.userInput ?? p.userPreview;
            const responseText = full?.responseText;
            const responseBlock =
              responseText != null
                ? `<div class="prompt-response">${escapeHtml(responseText)}</div>`
                : `<div class="prompt-pending">response pending…</div>`;
            return `
              <div class="prompt-card">
                <div class="prompt-card-header">
                  <span class="prompt-seq">#${p.seq}</span>
                  <span>session ${p.sessionId} · ${formatTimestamp(p.createdAt)}</span>
                </div>
                <div class="prompt-user">${escapeHtml(userInput ?? "")}</div>
                ${responseBlock}
              </div>`;
          })
          .join(""),
      );
    }
  }
}

async function refresh(): Promise<void> {
  try {
    sessions = await listSessions();
    if (activeSessionId != null && !sessions.some((s) => s.id === activeSessionId)) {
      activeSessionId = null;
    }
    renderSessions();
    if (activeSessionId == null && sessions.length > 0) {
      await openSession(sessions[0].id);
    } else if (activeSessionId != null) {
      await openSession(activeSessionId);
    } else {
      if (detailEl)
        detailEl.innerHTML = '<p class="prompts-empty">select a session to see its prompts.</p>';
    }
  } catch (err) {
    console.error("prompts refresh failed", err);
    if (detailEl)
      detailEl.innerHTML = `<p class="prompts-empty">error: ${escapeHtml(String(err))}</p>`;
  }
}

async function deleteSelectedSessions(): Promise<void> {
  const ids = [...selectedSessionIds];
  if (ids.length === 0) return;

  const noun = ids.length === 1 ? "session" : "sessions";
  const ok = window.confirm(
    `Delete ${ids.length} selected ${noun}? Their prompts will be removed. This action cannot be undone.`,
  );
  if (!ok) return;

  try {
    if (activeSessionId != null && selectedSessionIds.has(activeSessionId)) {
      activeSessionId = null;
    }
    await deleteSessions(ids);
    selectedSessionIds = new Set<number>();
    if (filterNeedle.trim().length > 0) {
      sessions = await listSessions();
      renderSessions();
      await runSearch();
    } else {
      await refresh();
    }
  } catch (err) {
    console.error("prompts delete failed", err);
    if (detailEl)
      detailEl.innerHTML = `<p class="prompts-empty">error: ${escapeHtml(String(err))}</p>`;
  }
}

function wire(): void {
  if (sessionsEl) {
    sessionsEl.addEventListener("change", (e) => {
      if (!(e.target instanceof HTMLInputElement)) return;
      if (!e.target.classList.contains("session-row-select")) return;
      const id = Number(e.target.dataset.sessionId);
      if (!Number.isFinite(id)) return;
      if (e.target.checked) selectedSessionIds.add(id);
      else selectedSessionIds.delete(id);
      renderSessions();
    });
    sessionsEl.addEventListener("click", (e) => {
      if (!(e.target instanceof HTMLElement)) return;
      if (e.target.closest(".session-row-check")) return;
      const target = e.target.closest<HTMLElement>(".session-row");
      const id = target?.dataset.sessionId;
      if (id) void openSession(Number(id));
    });
  }
  if (filterEl) {
    let t: ReturnType<typeof setTimeout> | null = null;
    filterEl.addEventListener("input", () => {
      filterNeedle = (filterEl as HTMLInputElement).value;
      if (t) clearTimeout(t);
      t = setTimeout(() => void runSearch(), 250);
    });
  }
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => void refresh());
  }
  if (deleteBtn instanceof HTMLButtonElement) {
    deleteBtn.addEventListener("click", () => void deleteSelectedSessions());
  }
  if (selectAllEl instanceof HTMLInputElement) {
    selectAllEl.addEventListener("change", () => {
      selectedSessionIds = selectAllEl.checked ? new Set(sessions.map((s) => s.id)) : new Set();
      renderSessions();
    });
  }
  const win = getCurrentWindow();
  void win.onFocusChanged(({ payload: focused }) => {
    if (focused) void refresh().catch(() => {});
  });
}

async function main(): Promise<void> {
  wire();
  await refresh();
}

void main();
