import { invoke } from "../../shared/tauri/invoke";
import type { SkillEntry, SkillExplainResult } from "./types";

export function listSkills(projectPaths: readonly string[]): Promise<SkillEntry[]> {
  return invoke<SkillEntry[]>(
    "skills_list",
    { projectPaths: [...projectPaths] },
    { errorMessage: "Could not scan installed skills" },
  );
}

export function readSkill(path: string): Promise<string> {
  return invoke<string>("skill_read", { path }, { errorMessage: "Could not read skill file" });
}

export function writeSkill(path: string, content: string): Promise<void> {
  return invoke<void>(
    "skill_write",
    { path, content },
    { errorMessage: "Could not save skill file" },
  );
}

export function explainSkill(
  cli: string,
  model: string,
  path: string,
): Promise<SkillExplainResult> {
  return invoke<SkillExplainResult>("skill_explain", { cli, model, path }, { toastOnError: false });
}
