import type { Project, Workspace } from "./types";

/**
 * Pure helpers for sidebar project filtering. No I/O, no classes — kept in a
 * dedicated module so the panel and rows stay thin and the matching logic is
 * unit-testable in isolation.
 */

/**
 * Multi-token AND match over `${workspace.name} ${project.name} ${project.path}`,
 * case-insensitive. An empty query matches everything. Mirrors the algorithm
 * used by the command palette so search feels consistent across surfaces.
 */
export function matchesProject(query: string, workspaceName: string, project: Project): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = `${workspaceName} ${project.name} ${project.path}`.toLowerCase();
  return q
    .split(/\s+/u)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

/**
 * Returns the projects of `workspace` that match `query`, preserving the
 * sorted order from the caller. Callers are responsible for hiding workspaces
 * whose filtered list is empty when a query is active.
 */
export function filterProjects(
  query: string,
  workspace: Workspace,
  projects: readonly Project[],
): Project[] {
  if (!query.trim()) return [...projects];
  return projects.filter((p) => matchesProject(query, workspace.name, p));
}
