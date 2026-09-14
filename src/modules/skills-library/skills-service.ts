import { invoke } from "../../shared/tauri/invoke";
import type { SkillEntry, SkillExplainResult } from "./types";

export function listSkills(projectPaths: readonly string[]): Promise<SkillEntry[]> {
  return invoke<SkillEntry[]>(
    "skills_list",
    { projectPaths: [...projectPaths] },
    { errorMessage: "Could not scan installed skills" },
  );
}

// `projectPath` names the repo that owns a project-scoped skill; the backend
// only widens the reachable roots for the project the call itself names.
export function readSkill(path: string, projectPath: string | null): Promise<string> {
  return invoke<string>(
    "skill_read",
    { path, projectPath },
    { errorMessage: "Could not read skill file" },
  );
}

export function writeSkill(
  path: string,
  content: string,
  projectPath: string | null,
): Promise<void> {
  return invoke<void>(
    "skill_write",
    { path, content, projectPath },
    { errorMessage: "Could not save skill file" },
  );
}

export function explainSkill(
  cli: string,
  model: string,
  path: string,
  projectPath: string | null,
): Promise<SkillExplainResult> {
  return invoke<SkillExplainResult>(
    "skill_explain",
    { cli, model, path, projectPath },
    { toastOnError: false },
  );
}
