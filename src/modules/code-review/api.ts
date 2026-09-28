import { invoke } from "@tauri-apps/api/core";
import type {
  BranchOverview,
  BranchRefs,
  ChangeGroup,
  ChangesOverview,
  DiffTarget,
  FileContents,
  ReviewFolder,
  ReviewProcesses,
} from "./types";

export function fetchChangesOverview(projectPath: string): Promise<ChangesOverview> {
  return invoke<ChangesOverview>("code_review_changes", { projectPath });
}

export function stagePaths(projectPath: string, paths: string[]): Promise<void> {
  return invoke<void>("code_review_stage", { projectPath, paths });
}

export function unstagePaths(projectPath: string, paths: string[]): Promise<void> {
  return invoke<void>("code_review_unstage", { projectPath, paths });
}

export function stageAll(projectPath: string): Promise<void> {
  return invoke<void>("code_review_stage_all", { projectPath });
}

export function fetchFileContents(projectPath: string, target: DiffTarget): Promise<FileContents> {
  return invoke<FileContents>("code_review_file_contents", {
    projectPath,
    path: target.path,
    originalPath: target.originalPath,
    source: target.source,
  });
}

export function fetchDefaultBase(projectPath: string): Promise<string | null> {
  return invoke<string | null>("code_review_default_base", { projectPath });
}

export function fetchBranchOverview(projectPath: string, base: string): Promise<BranchOverview> {
  return invoke<BranchOverview>("code_review_branch", { projectPath, base });
}

export function fetchBranchRefs(projectPath: string): Promise<BranchRefs> {
  return invoke<BranchRefs>("code_review_refs", { projectPath });
}

export function pullFastForward(projectPath: string): Promise<string> {
  return invoke<string>("code_review_pull", { projectPath });
}

export function switchBranch(projectPath: string, branch: string): Promise<string> {
  return invoke<string>("code_review_switch_branch", { projectPath, branch });
}

export function commitStaged(projectPath: string, message: string): Promise<string> {
  return invoke<string>("code_review_commit", { projectPath, message });
}

export function discardChanges(
  projectPath: string,
  paths: string[],
  group: ChangeGroup,
): Promise<void> {
  return invoke<void>("code_review_discard", { projectPath, paths, group });
}

export function startWatchingProject(projectPath: string): Promise<void> {
  return invoke<void>("code_review_watch_start", { projectPath });
}

export function prepareReviewFolder(projectPath: string, clear: boolean): Promise<ReviewFolder> {
  return invoke<ReviewFolder>("code_review_prepare_review", { projectPath, clear });
}

export function fetchReviewProcesses(projectPath: string): Promise<ReviewProcesses> {
  return invoke<ReviewProcesses>("code_review_processes", { projectPath });
}
