import type {
  ColorToken,
  Project,
  ProjectId,
  Workspace,
  WorkspaceId,
  WorkspacesState,
} from "./types";

// ---------------------------------------------------------------------------
// F4: appearance (color) reducer helpers for workspaces and projects.
//
// Pure helpers, single concern (no I/O, no class). Mirrors the structure of
// `workspaces-reducer-terminals.ts` and `workspaces-reducer-notes.ts` so the
// main reducer file can stay focused on workspace/project CRUD.
//
// Both setters are identity-preserving:
//   - return === state when the target id does not exist
//   - return === state when the current value already equals the new one
// `undefined` is the canonical "reset to default" value — passing it clears
// the field so the renderer can fall back to `deriveFallbackColor`.
// ---------------------------------------------------------------------------

/**
 * The 6-color palette consumed by the appearance picker, the CSS layer
 * (`[data-color="<token>"]`) and `deriveFallbackColor` below. Frozen so it can
 * be passed around without defensive copies.
 */
export const PALETTE: readonly ColorToken[] = Object.freeze([
  "slate",
  "blue",
  "purple",
  "pink",
  "green",
  "orange",
] as const);

export function setWorkspaceColor(
  state: WorkspacesState,
  id: WorkspaceId,
  color: ColorToken | undefined,
): WorkspacesState {
  let touched = false;
  const nextWorkspaces: Workspace[] = state.workspaces.map((w) => {
    if (w.id !== id) return w;
    if (w.color === color) return w;
    touched = true;
    const next: Workspace = { ...w, color };
    // When the caller passes `undefined`, drop the key entirely so persisted
    // payloads do not grow `{"color": undefined}` noise (JSON.stringify would
    // strip it anyway, but in-memory equality stays cleaner this way).
    if (color === undefined) delete (next as unknown as Record<string, unknown>).color;
    return next;
  });
  if (!touched) return state;
  return { ...state, workspaces: nextWorkspaces };
}

export function setProjectColor(
  state: WorkspacesState,
  id: ProjectId,
  color: ColorToken | undefined,
): WorkspacesState {
  let touched = false;
  const nextWorkspaces: Workspace[] = state.workspaces.map((workspace) => {
    let projectChanged = false;
    const projects: Project[] = workspace.projects.map((p) => {
      if (p.id !== id) return p;
      if (p.color === color) return p;
      projectChanged = true;
      const next: Project = { ...p, color };
      if (color === undefined) delete (next as unknown as Record<string, unknown>).color;
      return next;
    });
    if (!projectChanged) return workspace;
    touched = true;
    return { ...workspace, projects };
  });
  if (!touched) return state;
  return { ...state, workspaces: nextWorkspaces };
}

/**
 * Stable, deterministic fallback color for ids without an explicit `color`.
 * Cheap 32-bit string hash (FNV-1a variant) mod PALETTE.length. Pure — same
 * input always returns the same token, so a workspace's tint is consistent
 * across sessions and processes without persistence.
 */
export function deriveFallbackColor(id: string): ColorToken {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    // Multiply by FNV prime, keep it in 32-bit space.
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned so the modulo cannot land on a negative index.
  const idx = (hash >>> 0) % PALETTE.length;
  return PALETTE[idx];
}
