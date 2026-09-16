import { skillGroupLabel } from "./filter";
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
  activeProjectPath: string | null = null,
): void {
  listEl.replaceChildren();
  if (skills.length === 0) {
    const empty = document.createElement("div");
    empty.className = "agents-modal-empty";
    empty.textContent = "No skills found";
    listEl.append(empty);
    return;
  }
  let lastGroup: string | null = null;
  skills.forEach((s, idx) => {
    const group = skillGroupLabel(s);
    // Key on identity, not on the label: two projects can share a basename,
    // and keying on the label merged them under one header — which also
    // meant a foreign repo's skills could sit under a "current repo" badge.
    const groupKey = s.scope === "project" ? (s.projectPath ?? group) : "global";
    if (groupKey !== lastGroup) {
      lastGroup = groupKey;
      const header = document.createElement("div");
      header.className = "skills-modal-group";
      const name = document.createElement("span");
      name.className = "skills-modal-group-name";
      name.textContent = group;
      name.title = s.scope === "project" ? (s.projectPath ?? group) : s.source;
      header.append(name);
      if (s.scope === "project" && s.projectPath === activeProjectPath) {
        const badge = document.createElement("span");
        badge.className = "skills-modal-active-badge";
        badge.textContent = "current repo";
        header.append(badge);
      }
      listEl.append(header);
    }
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

    const scopeBadge = document.createElement("span");
    scopeBadge.className = "skills-modal-scope-badge";
    scopeBadge.dataset.scope = s.scope;
    scopeBadge.textContent = s.scope === "project" ? "project" : "general";

    head.append(name, badge, scopeBadge);

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
  rows.forEach((row) => {
    const idx = Number(row.dataset.idx);
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
  const scopeChip = document.createElement("span");
  scopeChip.className = "agents-modal-chip";
  scopeChip.textContent = skillGroupLabel(skill);
  chips.append(scopeChip);

  const sourceChip = document.createElement("span");
  sourceChip.className = "agents-modal-chip";
  sourceChip.textContent = skill.source;
  sourceChip.title = skill.path;
  chips.append(sourceChip);

  const body = document.createElement("pre");
  body.className = "agents-modal-preview-body";
  body.textContent = content ?? "Loading…";

  previewEl.append(chips, body);
}
