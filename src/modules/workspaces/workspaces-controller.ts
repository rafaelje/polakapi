import {
  flushSaveWorkspaces,
  loadWorkspaces,
  queueSaveWorkspaces,
} from "../../shared/persistence/workspaces-store";
import { confirmDeleteProject, confirmDeleteWorkspace } from "./confirm-delete";
import { validatePath } from "./path-validation";
import { openCreateProjectForm, openEditProjectPathForm } from "./project-form";
import { openCreateWorkspaceForm } from "./workspace-form";
import type {
  Project,
  ProjectId,
  Workspace,
  WorkspaceId,
  WorkspacesEvent,
  WorkspacesState,
} from "./types";
import {
  addProject,
  addWorkspace,
  changeProjectPath,
  deleteProject as reduceDeleteProject,
  deleteWorkspace as reduceDeleteWorkspace,
  duplicateProject,
  findProject,
  moveProject,
  renameProject,
  renameWorkspace,
  reorderProjects,
  reorderWorkspaces,
  resetAlphabeticalOrder,
  setActiveProject,
  setProjectPathInvalid,
  toggleCollapsed,
} from "./workspaces-reducer";

export type WorkspacesChangeListener = (event: WorkspacesEvent) => void;

export class WorkspacesController {
  private state: WorkspacesState;
  private readonly listeners = new Set<WorkspacesChangeListener>();
  private disposed = false;

  private constructor(initial: WorkspacesState) {
    this.state = initial;
  }

  static async load(): Promise<WorkspacesController> {
    const initial = await loadWorkspaces();
    const controller = new WorkspacesController(initial);
    void controller.revalidatePersistedPaths();
    return controller;
  }

  getState(): WorkspacesState {
    return this.state;
  }

  getActiveProject(): Project | null {
    if (!this.state.activeProjectId) return null;
    return findProject(this.state, this.state.activeProjectId)?.project ?? null;
  }

  on(listener: WorkspacesChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- Workspace mutations -----------------------------------------------

  async createWorkspaceInteractive(): Promise<Workspace | null> {
    const result = await openCreateWorkspaceForm();
    if (result.kind !== "ok") return null;
    const before = this.state.workspaces.length;
    this.commit(addWorkspace(this.state, result.name));
    return this.state.workspaces[before] ?? null;
  }

  renameWorkspace(id: WorkspaceId, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.commit(renameWorkspace(this.state, id, trimmed));
  }

  async deleteWorkspace(id: WorkspaceId): Promise<void> {
    const target = this.state.workspaces.find((w) => w.id === id);
    if (!target) return;
    const ok = await confirmDeleteWorkspace(target.name, target.projects.length);
    if (!ok) return;
    this.commit(reduceDeleteWorkspace(this.state, id));
  }

  toggleCollapsed(id: WorkspaceId): void {
    this.commit(toggleCollapsed(this.state, id));
  }

  reorderWorkspaces(ordered: WorkspaceId[]): void {
    this.commit(reorderWorkspaces(this.state, ordered));
  }

  // ---- Project mutations -------------------------------------------------

  async createProjectInteractive(workspaceId: WorkspaceId): Promise<Project | null> {
    const result = await openCreateProjectForm();
    if (result.kind !== "ok") return null;

    const workspace = this.state.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) return null;
    const before = workspace.projects.length;
    this.commit(addProject(this.state, { workspaceId, name: result.name, path: result.path }));
    const updated = this.state.workspaces.find((w) => w.id === workspaceId);
    const created = updated?.projects[before] ?? null;
    if (created) this.setActiveProject(created.id);
    return created;
  }

  renameProject(id: ProjectId, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.commit(renameProject(this.state, id, trimmed));
  }

  async changeProjectPathInteractive(id: ProjectId): Promise<boolean> {
    const found = findProject(this.state, id);
    if (!found) return false;
    const result = await openEditProjectPathForm({ project: found.project });
    if (result.kind !== "ok") return false;
    this.commit(changeProjectPath(this.state, id, result.path));
    return true;
  }

  async deleteProject(id: ProjectId): Promise<void> {
    const found = findProject(this.state, id);
    if (!found) return;
    const ok = await confirmDeleteProject(found.project.name, 0);
    if (!ok) return;
    this.commit(reduceDeleteProject(this.state, id));
  }

  duplicateProject(id: ProjectId): void {
    this.commit(duplicateProject(this.state, id));
  }

  moveProject(id: ProjectId, toWorkspaceId: WorkspaceId, atIndex: number): void {
    this.commit(moveProject(this.state, id, toWorkspaceId, atIndex));
  }

  reorderProjects(workspaceId: WorkspaceId, ordered: ProjectId[]): void {
    this.commit(reorderProjects(this.state, workspaceId, ordered));
  }

  resetAlphabeticalOrder(workspaceId: WorkspaceId): void {
    this.commit(resetAlphabeticalOrder(this.state, workspaceId));
  }

  setActiveProject(id: ProjectId | null): void {
    const next = setActiveProject(this.state, id);
    if (next === this.state) return;
    this.state = next;
    queueSaveWorkspaces(this.state);
    this.emit({ type: "state-changed", state: this.state });
    this.emit({ type: "active-project-changed", project: this.getActiveProject() });
  }

  async retryValidatePath(id: ProjectId): Promise<void> {
    const found = findProject(this.state, id);
    if (!found) return;
    const validation = await validatePath(found.project.path);
    this.commit(setProjectPathInvalid(this.state, id, !validation.ok));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    try {
      await flushSaveWorkspaces();
    } catch (error) {
      console.error("Failed to flush workspaces on dispose", error);
    }
  }

  // ---- Internals ---------------------------------------------------------

  private commit(next: WorkspacesState): void {
    if (next === this.state) return;
    const prevActive = this.state.activeProjectId;
    this.state = next;
    queueSaveWorkspaces(this.state);
    this.emit({ type: "state-changed", state: this.state });
    if (prevActive !== this.state.activeProjectId) {
      this.emit({ type: "active-project-changed", project: this.getActiveProject() });
    }
  }

  private emit(event: WorkspacesEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Workspaces listener threw", error);
      }
    }
  }

  private async revalidatePersistedPaths(): Promise<void> {
    const checks: Array<Promise<{ id: ProjectId; invalid: boolean }>> = [];
    for (const workspace of this.state.workspaces) {
      for (const project of workspace.projects) {
        checks.push(validatePath(project.path).then((v) => ({ id: project.id, invalid: !v.ok })));
      }
    }
    if (checks.length === 0) return;
    const results = await Promise.all(checks);
    let next = this.state;
    for (const { id, invalid } of results) {
      next = setProjectPathInvalid(next, id, invalid);
    }
    if (next !== this.state) {
      this.state = next;
      queueSaveWorkspaces(this.state);
      this.emit({ type: "state-changed", state: this.state });
    }
  }
}
