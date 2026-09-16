import type { SkillEntry } from "./types";

/** `all`, `global`, or the absolute path of a project that ships skills. */
export type SkillScopeFilter = string;

export const SCOPE_ALL = "all";
export const SCOPE_GLOBAL = "global";

export interface SkillScopeOption {
  value: SkillScopeFilter;
  label: string;
  count: number;
}

export function projectName(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function skillGroupLabel(skill: SkillEntry): string {
  if (skill.scope === "project" && skill.projectPath) {
    return `project · ${projectName(skill.projectPath)}`;
  }
  return "general skills";
}

export function matchesScope(skill: SkillEntry, scope: SkillScopeFilter): boolean {
  if (scope === SCOPE_ALL) return true;
  if (scope === SCOPE_GLOBAL) return skill.scope === "global";
  return skill.scope === "project" && skill.projectPath === scope;
}

export function filterSkills(
  skills: readonly SkillEntry[],
  query: string,
  scope: SkillScopeFilter = SCOPE_ALL,
): SkillEntry[] {
  const inScope = skills.filter((s) => matchesScope(s, scope));
  const q = query.trim().toLowerCase();
  if (!q) return inScope;
  const tokens = q.split(/\s+/u).filter(Boolean);
  return inScope.filter((s) => {
    const haystack =
      `${s.cli} ${s.name} ${s.description} ${s.source} ${skillGroupLabel(s)}`.toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
}

/**
 * Project skills first — the active repo before the rest — then the global
 * ones, so the list reads from most to least specific.
 */
export function sortSkills(
  skills: readonly SkillEntry[],
  activeProjectPath: string | null,
): SkillEntry[] {
  const rank = (s: SkillEntry): number => {
    if (s.scope !== "project") return 2;
    return s.projectPath === activeProjectPath ? 0 : 1;
  };
  return [...skills].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const byGroup = skillGroupLabel(a).localeCompare(skillGroupLabel(b));
    if (byGroup !== 0) return byGroup;
    // Same label can still mean different repos; without this they interleave
    // and the list renders alternating duplicate headers.
    const byPath = (a.projectPath ?? "").localeCompare(b.projectPath ?? "");
    if (byPath !== 0) return byPath;
    const byCli = a.cli.localeCompare(b.cli);
    if (byCli !== 0) return byCli;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

export function skillScopeOptions(
  skills: readonly SkillEntry[],
  activeProjectPath: string | null,
): SkillScopeOption[] {
  const globals = skills.filter((s) => s.scope === "global").length;
  const byProject = new Map<string, number>();
  for (const skill of skills) {
    if (skill.scope !== "project" || !skill.projectPath) continue;
    byProject.set(skill.projectPath, (byProject.get(skill.projectPath) ?? 0) + 1);
  }
  const projects = [...byProject.entries()]
    .map(([path, count]) => ({
      value: path,
      label: path === activeProjectPath ? `${projectName(path)} (current)` : projectName(path),
      count,
    }))
    .sort((a, b) => {
      if (a.value === activeProjectPath) return -1;
      if (b.value === activeProjectPath) return 1;
      return a.label.localeCompare(b.label);
    });
  return [
    { value: SCOPE_ALL, label: "all skills", count: skills.length },
    { value: SCOPE_GLOBAL, label: "general only", count: globals },
    ...projects,
  ];
}
