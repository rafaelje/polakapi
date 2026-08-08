import {
  flushSaveWorkspaces,
  loadWorkspaces,
  queueSaveWorkspaces,
} from "../../../shared/persistence/workspaces-store";
import {
  confirmDeleteFolder,
  confirmDeleteProject,
  confirmDeleteProjects,
  confirmDeleteWorkspace,
} from "../forms/confirm-delete";
import { validatePath } from "../path-validation";
import { pickProjectFolder } from "../path-picker";
import { openCreateProjectForm, openEditProjectPathForm } from "../forms/project-form";
import { invoke, InvokeError } from "../../../shared/tauri/invoke";
import { promptModal } from "../../../shared/ui/modal";
import { showToast } from "../../../shared/ui/toast";
import { applyPathValidationResults, collectPathValidationResults } from "../revalidate-paths";
import { openCreateWorkspaceForm } from "../forms/workspace-form";
import {
  saveLayoutTemplate as reduceSaveLayoutTemplate,
  deleteLayoutTemplate as reduceDeleteLayoutTemplate,
} from "./workspaces-reducer-templates";
import {
  setProjectShortcut as reduceSetProjectShortcut,
  setWorkspaceShortcut as reduceSetWorkspaceShortcut,
} from "./workspaces-reducer-shortcuts";
import type {
  ColorToken,
  Folder,
  FolderId,
  LayoutTemplate,
  Project,
  ProjectId,
  TerminalLayoutNode,
  TerminalSpec,
  Workspace,
  WorkspaceId,
  WorkspacesEvent,
  WorkspacesState,
} from "./types";
import {
  addFolder,
  addProject,
  addTerminalSpec,
  addWorkspace,
  changeProjectPath,
  deleteFolder as reduceDeleteFolder,
  deleteProject as reduceDeleteProject,
  deleteProjects as reduceDeleteProjects,
  deleteWorkspace as reduceDeleteWorkspace,
  duplicateProject,
  findProject,
  moveFolderDown as reduceMoveFolderDown,
  moveFolderUp as reduceMoveFolderUp,
  moveProject,
  moveProjects,
  moveProjectToBucket as reduceMoveProjectToBucket,
  moveProjectsToBucket as reduceMoveProjectsToBucket,
  moveProjectToFolder as reduceMoveProjectToFolder,
  removeTerminalSpec,
  renameFolder as reduceRenameFolder,
  renameProject,
  renameWorkspace,
  reorderProjects,
  reorderProjectsInFolder as reduceReorderProjectsInFolder,
  reorderWorkspaces,
  replaceTerminalSpecs,
  resetAlphabeticalOrder,
  resetAlphabeticalOrderInFolder as reduceResetAlphabeticalOrderInFolder,
  setActiveProject,
  setProjectActiveCli,
  setProjectTerminalLayout,
  setProjectColor,
  setProjectNotes,
  setProjectPathInvalid,
  setWorkspaceColor,
  setAllCollapsed,
  toggleCollapsed,
  toggleFolderCollapsed as reduceToggleFolderCollapsed,
  updateTerminalSpec,
} from "./workspaces-reducer";

export type WorkspacesChangeListener = (event: WorkspacesEvent) => void;

export class WorkspacesController {
  private state: WorkspacesState;
  private readonly listeners = new Set<WorkspacesChangeListener>();
  private disposed = false;
  private deleteHook: ((id: ProjectId) => void | Promise<void>) | null = null;

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
    await this.runDeleteProjectHooks(
      target.projects.map((project) => project.id),
      "Workspace delete teardown failed",
    );
    this.commit(reduceDeleteWorkspace(this.state, id));
  }

  toggleCollapsed(id: WorkspaceId): void {
    this.commit(toggleCollapsed(this.state, id));
  }

  setAllCollapsed(collapsed: boolean): void {
    this.commit(setAllCollapsed(this.state, collapsed));
  }

  areAllCollapsed(): boolean {
    const { workspaces } = this.state;
    return workspaces.length > 0 && workspaces.every((w) => w.collapsed === true);
  }

  reorderWorkspaces(ordered: WorkspaceId[]): void {
    this.commit(reorderWorkspaces(this.state, ordered));
  }

  async createProjectInteractive(
    workspaceId: WorkspaceId,
    opts?: { initialFolderId?: FolderId; defaultPath?: string },
  ): Promise<Project | null> {
    const workspace = this.state.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) return null;
    const result = await openCreateProjectForm({
      defaultPath: opts?.defaultPath,
      folders: workspace.folders ?? [],
      initialFolderId: opts?.initialFolderId,
    });
    if (result.kind !== "ok") return null;

    const before = workspace.projects.length;
    this.commit(
      addProject(this.state, {
        workspaceId,
        name: result.name,
        path: result.path,
        folderId: result.folderId,
      }),
    );
    const updated = this.state.workspaces.find((w) => w.id === workspaceId);
    const created = updated?.projects[before] ?? null;
    if (created) this.setActiveProject(created.id);
    return created;
  }

  /**
   * Non-interactive project creation. Callers (e.g. Finder drop) must have
   * already validated the path. The resulting commit fires the same
   * `state-changed` event as `createProjectInteractive`, so the sidebar
   * re-renders normally.
   */
  addProject(
    workspaceId: WorkspaceId,
    input: { name: string; path: string; color?: ColorToken; folderId?: FolderId },
  ): Project | null {
    const workspace = this.state.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) return null;
    const before = workspace.projects.length;
    this.commit(
      addProject(this.state, {
        workspaceId,
        name: input.name,
        path: input.path,
        color: input.color,
        folderId: input.folderId,
      }),
    );
    const updated = this.state.workspaces.find((w) => w.id === workspaceId);
    return updated?.projects[before] ?? null;
  }

  // Prompts a git URL, clones it into the folder's directory (or a picked
  // destination) and registers the clone as a project.
  async cloneRepoInteractive(
    workspaceId: WorkspaceId,
    opts?: { folderId?: FolderId },
  ): Promise<Project | null> {
    const workspace = this.state.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) return null;
    const folder = opts?.folderId
      ? workspace.folders?.find((f) => f.id === opts.folderId)
      : undefined;

    const url = await promptModal({
      title: "Clone repository",
      message: folder?.path ?? "Pick the destination directory after entering the URL.",
      placeholder: "git@github.com:user/repo.git",
      confirmLabel: "Clone",
    });
    if (url === null || !url.trim()) return null;

    const destParent = folder?.path ?? (await pickProjectFolder());
    if (!destParent) return null;

    showToast("Cloning repository…", "info");
    let path: string;
    try {
      path = await invoke<string>(
        "git_clone_repo",
        { url: url.trim(), destParent },
        { toastOnError: false },
      );
    } catch (cause) {
      const raw = cause instanceof InvokeError ? cause.cause : cause;
      showToast(typeof raw === "string" ? raw : "Clone failed", "error");
      return null;
    }

    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
    const created = this.addProject(workspaceId, { name, path, folderId: folder?.id });
    if (!created) {
      showToast(`Cloned into ${path}, but the project could not be added`, "error");
      return null;
    }
    this.setActiveProject(created.id);
    showToast(`Cloned into ${path}`, "success");
    return created;
  }

  // Runs `git worktree add` for `branch` and registers a new Project pointing at it.
  async createProjectWorktree(id: ProjectId, branch: string): Promise<Project | null> {
    const found = findProject(this.state, id);
    if (!found) return null;
    const { workspace, project } = found;

    let worktreePath: string;
    try {
      worktreePath = await invoke<string>(
        "git_create_worktree",
        { projectPath: project.path, branch },
        { toastOnError: false },
      );
    } catch (cause) {
      const raw = cause instanceof InvokeError ? cause.cause : cause;
      showToast(typeof raw === "string" ? raw : "Could not create worktree", "error");
      return null;
    }

    const created = this.addProject(workspace.id, {
      name: `${project.name} (${branch})`,
      path: worktreePath,
      color: project.color,
      folderId: project.folderId,
    });
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
    await this.deleteProjectWithLiveCount(id, 0);
  }

  /**
   * Confirms deletion with the live PTY count from the router. The optional
   * `onBeforeRemove` (or `setDeleteProjectHook`) tears down PTYs after the
   * user confirms and before the reducer removes the project.
   */
  async deleteProjectWithLiveCount(
    id: ProjectId,
    liveCount: number,
    onBeforeRemove?: (id: ProjectId) => void | Promise<void>,
  ): Promise<boolean> {
    const found = findProject(this.state, id);
    if (!found) return false;
    if (!(await confirmDeleteProject(found.project.name, liveCount))) return false;
    await this.runDeleteProjectHooks([id], "Project delete teardown failed", onBeforeRemove);
    this.commit(reduceDeleteProject(this.state, id));
    return true;
  }

  async deleteProjectsWithLiveCount(
    ids: readonly ProjectId[],
    totalLiveCount: number,
  ): Promise<boolean> {
    const present = ids.filter((id) => findProject(this.state, id));
    if (present.length === 0) return false;
    if (!(await confirmDeleteProjects(present.length, totalLiveCount))) return false;
    await this.runDeleteProjectHooks(present, "Bulk project delete teardown failed");
    this.commit(reduceDeleteProjects(this.state, present));
    return true;
  }

  /** Registered by the app bootstrap so PTYs tear down before reducer remove. */
  setDeleteProjectHook(hook: ((id: ProjectId) => void | Promise<void>) | null): () => void {
    this.deleteHook = hook;
    return () => {
      if (this.deleteHook === hook) this.deleteHook = null;
    };
  }

  addTerminalSpec = (projectId: ProjectId, spec: TerminalSpec): void =>
    this.commit(addTerminalSpec(this.state, projectId, spec));
  removeTerminalSpec = (projectId: ProjectId, terminalId: string): void =>
    this.commit(removeTerminalSpec(this.state, projectId, terminalId));
  updateTerminalSpec = (
    projectId: ProjectId,
    terminalId: string,
    patch: Partial<Omit<TerminalSpec, "id">>,
  ): void => this.commit(updateTerminalSpec(this.state, projectId, terminalId, patch));
  replaceTerminalSpecs = (projectId: ProjectId, specs: TerminalSpec[]): void =>
    this.commit(replaceTerminalSpecs(this.state, projectId, specs));
  setProjectActiveCli = (projectId: ProjectId, cliId: string): void =>
    this.commit(setProjectActiveCli(this.state, projectId, cliId));
  setProjectTerminalLayout = (projectId: ProjectId, layout: TerminalLayoutNode | null): void =>
    this.commit(setProjectTerminalLayout(this.state, projectId, layout));

  // F3: per-project notes. The debounce lives in the notes panel (400ms), so
  // each call here is already coalesced — we just commit and let the existing
  // queueSaveWorkspaces 300ms window collapse adjacent writes.
  setProjectNotes = (projectId: ProjectId, notes: string): void =>
    this.commit(setProjectNotes(this.state, projectId, notes));

  // F4: appearance (color) wrappers. Thin commit wrappers — same
  // arrow-property style as the terminal/notes setters above. Pass `undefined`
  // to clear the field and fall back to the deterministic palette at render
  // time.
  setWorkspaceColor = (id: WorkspaceId, color: ColorToken | undefined): void =>
    this.commit(setWorkspaceColor(this.state, id, color));
  setProjectColor = (id: ProjectId, color: ColorToken | undefined): void =>
    this.commit(setProjectColor(this.state, id, color));

  /** Returns the project's notes, or '' when project is missing or unset. */
  getProjectNotes(projectId: ProjectId): string {
    return findProject(this.state, projectId)?.project.notes ?? "";
  }

  setProjectShortcut = (id: ProjectId, shortcut: string | undefined): void =>
    this.commit(reduceSetProjectShortcut(this.state, id, shortcut));
  setWorkspaceShortcut = (id: WorkspaceId, shortcut: string | undefined): void =>
    this.commit(reduceSetWorkspaceShortcut(this.state, id, shortcut));

  saveLayoutTemplate = (template: LayoutTemplate): void =>
    this.commit(reduceSaveLayoutTemplate(this.state, template));
  deleteLayoutTemplate = (templateId: string): void =>
    this.commit(reduceDeleteLayoutTemplate(this.state, templateId));

  getLayoutTemplates(): readonly LayoutTemplate[] {
    return this.state.layoutTemplates ?? [];
  }

  duplicateProject = (id: ProjectId): void => this.commit(duplicateProject(this.state, id));
  moveProject = (id: ProjectId, toWorkspaceId: WorkspaceId, atIndex: number): void =>
    this.commit(moveProject(this.state, id, toWorkspaceId, atIndex));
  moveProjects = (ids: readonly ProjectId[], toWorkspaceId: WorkspaceId, atIndex: number): void =>
    this.commit(moveProjects(this.state, ids, toWorkspaceId, atIndex));
  reorderProjects = (workspaceId: WorkspaceId, ordered: ProjectId[]): void =>
    this.commit(reorderProjects(this.state, workspaceId, ordered));
  resetAlphabeticalOrder = (workspaceId: WorkspaceId): void =>
    this.commit(resetAlphabeticalOrder(this.state, workspaceId));

  // Single-level sidebar folders. Same thin commit-wrapper style as the
  // project/workspace setters above.
  // Picks a parent directory, prompts a name, creates `parent/name` on disk
  // and registers it as a sidebar folder backed by that path.
  async createFolderInteractive(workspaceId: WorkspaceId): Promise<Folder | null> {
    const workspace = this.state.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) return null;

    const parent = await pickProjectFolder();
    if (!parent) return null;

    const name = await promptModal({
      title: "New folder",
      message: `Will be created inside ${parent}`,
      placeholder: "Folder name",
      confirmLabel: "Create",
    });
    if (name === null) return null;
    const trimmed = name.trim();
    if (!trimmed) return null;

    let path: string;
    try {
      path = await invoke<string>(
        "fs_create_folder",
        { parent, name: trimmed },
        { toastOnError: false },
      );
    } catch (cause) {
      const raw = cause instanceof InvokeError ? cause.cause : cause;
      showToast(typeof raw === "string" ? raw : "Could not create folder", "error");
      return null;
    }

    const before = workspace.folders?.length ?? 0;
    this.commit(addFolder(this.state, workspaceId, trimmed, path));
    const updated = this.state.workspaces.find((w) => w.id === workspaceId);
    return updated?.folders?.[before] ?? null;
  }

  renameFolder = (workspaceId: WorkspaceId, folderId: FolderId, name: string): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.commit(reduceRenameFolder(this.state, workspaceId, folderId, trimmed));
  };

  async deleteFolderInteractive(workspaceId: WorkspaceId, folderId: FolderId): Promise<void> {
    const workspace = this.state.workspaces.find((w) => w.id === workspaceId);
    const folder = workspace?.folders?.find((f) => f.id === folderId);
    if (!workspace || !folder) return;
    const memberCount = workspace.projects.filter((p) => p.folderId === folderId).length;
    if (!(await confirmDeleteFolder(folder.name, memberCount))) return;
    this.commit(reduceDeleteFolder(this.state, workspaceId, folderId));
  }

  toggleFolderCollapsed = (workspaceId: WorkspaceId, folderId: FolderId): void =>
    this.commit(reduceToggleFolderCollapsed(this.state, workspaceId, folderId));
  moveFolderUp = (workspaceId: WorkspaceId, folderId: FolderId): void =>
    this.commit(reduceMoveFolderUp(this.state, workspaceId, folderId));
  moveFolderDown = (workspaceId: WorkspaceId, folderId: FolderId): void =>
    this.commit(reduceMoveFolderDown(this.state, workspaceId, folderId));
  resetAlphabeticalOrderInFolder = (
    workspaceId: WorkspaceId,
    folderId: FolderId | undefined,
  ): void => this.commit(reduceResetAlphabeticalOrderInFolder(this.state, workspaceId, folderId));

  /** Row-menu "Move to folder" entry point — same-workspace only. */
  moveProjectToFolder = (projectId: ProjectId, folderId: FolderId | undefined): void =>
    this.commit(reduceMoveProjectToFolder(this.state, projectId, folderId));

  /** Drag-and-drop entry point (single project, bucket-aware). */
  moveProjectToBucket = (
    projectId: ProjectId,
    toWorkspaceId: WorkspaceId,
    folderId: FolderId | undefined,
    atIndex: number,
  ): void =>
    this.commit(reduceMoveProjectToBucket(this.state, projectId, toWorkspaceId, folderId, atIndex));

  /** Drag-and-drop entry point (bulk, bucket-aware). */
  moveProjectsToBucket = (
    projectIds: readonly ProjectId[],
    toWorkspaceId: WorkspaceId,
    folderId: FolderId | undefined,
    atIndex: number,
  ): void =>
    this.commit(
      reduceMoveProjectsToBucket(this.state, projectIds, toWorkspaceId, folderId, atIndex),
    );

  /** Drag-and-drop entry point (same-bucket pointer reorder). */
  reorderProjectsInFolder = (
    workspaceId: WorkspaceId,
    folderId: FolderId | undefined,
    ordered: ProjectId[],
  ): void => this.commit(reduceReorderProjectsInFolder(this.state, workspaceId, folderId, ordered));

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

  private async runDeleteProjectHooks(
    ids: ProjectId[],
    errorMessage: string,
    hookOverride?: (id: ProjectId) => void | Promise<void>,
  ): Promise<void> {
    const hook = hookOverride ?? this.deleteHook;
    if (!hook) return;
    for (const id of ids) {
      try {
        await hook(id);
      } catch (error) {
        console.error(errorMessage, error);
      }
    }
  }

  private async revalidatePersistedPaths(): Promise<void> {
    const results = await collectPathValidationResults(this.state);
    const next = applyPathValidationResults(this.state, results);
    if (next === this.state) return;
    this.state = next;
    queueSaveWorkspaces(this.state);
    this.emit({ type: "state-changed", state: this.state });
  }
}
