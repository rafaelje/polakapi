import type { LayoutTemplate, WorkspacesState } from "./types";

// ---------------------------------------------------------------------------
// Layout templates: named, project-agnostic snapshots of a terminal
// arrangement. Pure reducer helpers, mirroring workspaces-reducer-notes.ts.
// ---------------------------------------------------------------------------

/**
 * Upserts a template. Matching is by (trimmed, case-insensitive) name so
 * "Save current layout…" with an existing name replaces it instead of
 * accumulating duplicates. Identity-preserving: returns === state when the
 * template name is empty.
 */
export function saveLayoutTemplate(
  state: WorkspacesState,
  template: LayoutTemplate,
): WorkspacesState {
  const name = template.name.trim();
  if (!name) return state;
  const normalized: LayoutTemplate = { ...template, name };
  const templates = state.layoutTemplates ?? [];
  const idx = templates.findIndex((t) => t.name.toLowerCase() === name.toLowerCase());
  const next =
    idx === -1
      ? [...templates, normalized]
      : templates.map((t, i) => (i === idx ? { ...normalized, id: t.id } : t));
  return { ...state, layoutTemplates: next };
}

/** Removes a template by id. Identity-preserving when the id is unknown. */
export function deleteLayoutTemplate(state: WorkspacesState, templateId: string): WorkspacesState {
  const templates = state.layoutTemplates ?? [];
  const next = templates.filter((t) => t.id !== templateId);
  if (next.length === templates.length) return state;
  return { ...state, layoutTemplates: next };
}
