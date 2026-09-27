import { invoke } from "@tauri-apps/api/core";
import type { ChangedFile, ChangesOverview, ContentSource, FileContents } from "./types";

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

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unexpected error";
}
