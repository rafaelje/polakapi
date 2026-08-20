import type { SkillEntry } from "./types";

export function filterSkills(skills: readonly SkillEntry[], query: string): SkillEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...skills];
  const tokens = q.split(/\s+/u).filter(Boolean);
  return skills.filter((s) => {
    const haystack = `${s.cli} ${s.name} ${s.description} ${s.source}`.toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
}
