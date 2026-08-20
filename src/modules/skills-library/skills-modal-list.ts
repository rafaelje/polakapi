import type { SkillEntry } from "./types";

export interface SkillListCallbacks {
  onHover(idx: number): void;
  onActivate(idx: number): void;
}

export function renderSkillList(
  listEl: HTMLElement,
  skills: readonly SkillEntry[],
  selectedIdx: number,
  cb: SkillListCallbacks,
): void {
  listEl.replaceChildren();
  if (skills.length === 0) {
    const empty = document.createElement("div");
    empty.className = "agents-modal-empty";
    empty.textContent = "No skills found";
    listEl.append(empty);
    return;
  }
  skills.forEach((s, idx) => {
    const row = document.createElement("div");
    row.className = "agents-modal-row";
    row.setAttribute("role", "option");
    if (idx === selectedIdx) row.setAttribute("aria-selected", "true");
    row.dataset.idx = String(idx);

    const head = document.createElement("div");
    head.className = "skills-modal-row-head";

    const name = document.createElement("span");
    name.className = "agents-modal-row-name";
    name.textContent = s.name;

    const badge = document.createElement("span");
    badge.className = "skills-modal-cli-badge";
    badge.dataset.cli = s.cli;
    badge.textContent = s.cli;

    head.append(name, badge);

    const desc = document.createElement("div");
    desc.className = "agents-modal-row-desc";
    desc.textContent = s.description || " ";

    row.append(head, desc);
    row.addEventListener("mouseenter", () => cb.onHover(idx));
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      cb.onActivate(idx);
    });
    listEl.append(row);
  });
}

export function updateSkillSelection(listEl: HTMLElement, selectedIdx: number): void {
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

export function renderSkillPreview(
  previewEl: HTMLElement,
  skill: SkillEntry | null,
  content: string | null,
): void {
  previewEl.replaceChildren();
  if (!skill) {
    const empty = document.createElement("div");
    empty.className = "agents-modal-preview-empty";
    empty.textContent = "Select a skill to preview";
    previewEl.append(empty);
    return;
  }
  const chips = document.createElement("div");
  chips.className = "agents-modal-chips";
  const sourceChip = document.createElement("span");
  sourceChip.className = "agents-modal-chip";
  sourceChip.textContent = skill.source;
  chips.append(sourceChip);

  const body = document.createElement("pre");
  body.className = "agents-modal-preview-body";
  body.textContent = content ?? "Loading…";

  previewEl.append(chips, body);
}
