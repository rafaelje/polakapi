import { validatePath } from "./path-validation";
import type { ProjectId, WorkspacesState } from "./types";
import { setProjectPathInvalid } from "./workspaces-reducer";

/**
 * Boot-time pass over every persisted project path. Concurrently calls
 * `validatePath` for each, then reduces the results into a fresh state
 * with `pathInvalid` flags updated. Returns the new state, or the original
 * reference when nothing changed (caller can fast-path on identity).
 */
export async function revalidatePersistedPaths(state: WorkspacesState): Promise<WorkspacesState> {
  const checks: Array<Promise<{ id: ProjectId; invalid: boolean }>> = [];
  for (const workspace of state.workspaces) {
    for (const project of workspace.projects) {
      checks.push(validatePath(project.path).then((v) => ({ id: project.id, invalid: !v.ok })));
    }
  }
  if (checks.length === 0) return state;
  const results = await Promise.all(checks);
  let next = state;
  for (const { id, invalid } of results) {
    next = setProjectPathInvalid(next, id, invalid);
  }
  return next;
}
