import { invoke } from "@tauri-apps/api/core";
import type { ChangesOverview } from "./types";

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

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unexpected error";
}
