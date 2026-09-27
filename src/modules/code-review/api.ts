import { invoke } from "@tauri-apps/api/core";
import type {
  BranchRefs,
  ChangedFile,
  ChangesOverview,
  ContentSource,
  FileContents,
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

export function fetchFileContents(projectPath: string, file: ChangedFile): Promise<FileContents> {
  const source: ContentSource = { kind: file.group };
  return invoke<FileContents>("code_review_file_contents", {
    projectPath,
    path: file.path,
    originalPath: file.originalPath,
    source,
  });
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

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unexpected error";
}
