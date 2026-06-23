import { validatePath } from "./path-validation";
import type { ProjectId, WorkspacesState } from "./types";
import { findProject, setProjectPathInvalid } from "./workspaces-reducer";

export interface PathRevalidationResult {
  id: ProjectId;
  path: string;
  invalid: boolean;
}

/**
 * Boot-time pass over every persisted project path. The returned results carry
 * the exact path that was validated so callers can apply them to a newer state
 * without marking a project based on a stale path.
 */
export async function collectPathValidationResults(
  state: WorkspacesState,
): Promise<PathRevalidationResult[]> {
  const checks: Array<Promise<PathRevalidationResult>> = [];
  for (const workspace of state.workspaces) {
    for (const project of workspace.projects) {
      checks.push(
        validatePath(project.path).then((v) => ({
          id: project.id,
          path: project.path,
          invalid: !v.ok,
        })),
      );
    }
  }
  return Promise.all(checks);
}

/**
 * Applies path validation results to `state` without overwriting unrelated
 * fields that may have changed while validation was in flight. If a project was
 * deleted or its path changed, that validation result is stale and ignored.
 */
export function applyPathValidationResults(
  state: WorkspacesState,
  results: PathRevalidationResult[],
): WorkspacesState {
  let next = state;
  for (const { id, path, invalid } of results) {
    const current = findProject(next, id)?.project;
    if (!current || current.path !== path) continue;
    if ((current.pathInvalid === true) === invalid) continue;
    next = setProjectPathInvalid(next, id, invalid);
  }
  return next;
}

export async function revalidatePersistedPaths(state: WorkspacesState): Promise<WorkspacesState> {
  const results = await collectPathValidationResults(state);
  return applyPathValidationResults(state, results);
}
