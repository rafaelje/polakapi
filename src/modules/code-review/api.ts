import { invoke } from "@tauri-apps/api/core";
import type { ChangesOverview } from "./types";

export function fetchChangesOverview(projectPath: string): Promise<ChangesOverview> {
  return invoke<ChangesOverview>("code_review_changes", { projectPath });
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unexpected error";
}
