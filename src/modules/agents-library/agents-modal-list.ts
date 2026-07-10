import { composeAgentText } from "./compose";
import type { AgentDef } from "./types";

export interface AgentListCallbacks {
  onHover(idx: number): void;
  onActivate(idx: number): void;
}

/**
 * Render agent rows. Kept dumb — the modal owns state, this file just paints.
 * Selection visuals are updated by `updateAgentSelection` so arrow keys and
 * hover can shift the cursor without a full re-render.
 */
export function renderAgentList(
  listEl: HTMLElement,
  agents: readonly AgentDef[],
  selectedIdx: number,
  cb: AgentListCallbacks,
): void {
  listEl.replaceChildren();
  if (agents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "agents-modal-empty";
    empty.textContent = "No agents match";
    listEl.append(empty);
    return;
  }
  agents.forEach((a, idx) => {
    const row = document.createElement("div");
    row.className = "agents-modal-row";
    row.setAttribute("role", "option");
    if (idx === selectedIdx) row.setAttribute("aria-selected", "true");
    row.dataset.idx = String(idx);

    const name = document.createElement("div");
    name.className = "agents-modal-row-name";
    name.textContent = a.name;

    const desc = document.createElement("div");
    desc.className = "agents-modal-row-desc";
    desc.textContent = a.description || " ";

    const meta = document.createElement("div");
    meta.className = "agents-modal-row-meta";
    meta.textContent = `${a.files.length} file${a.files.length === 1 ? "" : "s"}`;

    row.append(name, desc, meta);
    row.addEventListener("mouseenter", () => cb.onHover(idx));
    row.addEventListener("mousedown", (e) => {
      // mousedown beats the backdrop click-to-close.
      e.preventDefault();
      e.stopPropagation();
      cb.onActivate(idx);
    });
    listEl.append(row);
  });
}

export function updateAgentSelection(listEl: HTMLElement, selectedIdx: number): void {
  const rows = listEl.querySelectorAll<HTMLElement>(".agents-modal-row");
  rows.forEach((row, idx) => {
    if (idx === selectedIdx) {
      row.setAttribute("aria-selected", "true");
      row.scrollIntoView({ block: "nearest" });
    } else {
      row.removeAttribute("aria-selected");
    }
  });
}

/**
 * Render the right-column preview for the selected agent (or a placeholder
 * when nothing is selected).
 */
export function renderAgentPreview(previewEl: HTMLElement, agent: AgentDef | null): void {
  previewEl.replaceChildren();
  if (!agent) {
    const empty = document.createElement("div");
    empty.className = "agents-modal-preview-empty";
    empty.textContent = "Select an agent to preview";
    previewEl.append(empty);
    return;
  }
  const chips = document.createElement("div");
  chips.className = "agents-modal-chips";
  for (const f of agent.files) {
    const chip = document.createElement("span");
    chip.className = "agents-modal-chip";
    chip.textContent = f.title;
    chips.append(chip);
  }

  const body = document.createElement("pre");
  body.className = "agents-modal-preview-body";
  body.textContent = composeAgentText(agent);

  previewEl.append(chips, body);
}
