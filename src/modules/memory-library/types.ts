export interface MemoryFileEntry {
  name: string;
  description: string;
  path: string;
  isIndex: boolean;
}

export interface MemoryProjectGroup {
  dirName: string;
  files: MemoryFileEntry[];
}

export interface MemoryRow {
  /** Munged ~/.claude/projects dir name this file belongs to. */
  dirName: string;
  /** Real project path when a known project matches, else the dir name. */
  projectLabel: string;
  isActiveProject: boolean;
  file: MemoryFileEntry;
}

/**
 * Claude Code names each project dir by replacing every non-alphanumeric
 * character of the absolute path with `-`.
 */
export function encodeProjectDir(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

export function buildRows(
  groups: readonly MemoryProjectGroup[],
  knownProjectPaths: readonly string[],
  activeProjectPath: string | null,
): MemoryRow[] {
  const labelByDir = new Map<string, string>();
  for (const path of knownProjectPaths) {
    labelByDir.set(encodeProjectDir(path), path);
  }
  const activeDir = activeProjectPath ? encodeProjectDir(activeProjectPath) : null;
  const rows: MemoryRow[] = [];
  for (const group of groups) {
    for (const file of group.files) {
      rows.push({
        dirName: group.dirName,
        projectLabel: labelByDir.get(group.dirName) ?? group.dirName,
        isActiveProject: group.dirName === activeDir,
        file,
      });
    }
  }
  rows.sort((a, b) => {
    if (a.isActiveProject !== b.isActiveProject) return a.isActiveProject ? -1 : 1;
    const byProject = a.projectLabel.toLowerCase().localeCompare(b.projectLabel.toLowerCase());
    if (byProject !== 0) return byProject;
    if (a.file.isIndex !== b.file.isIndex) return a.file.isIndex ? -1 : 1;
    return a.file.name.toLowerCase().localeCompare(b.file.name.toLowerCase());
  });
  return rows;
}

/** `all`, or the munged project dir the rows must belong to. */
export type MemoryProjectFilter = string;

export const ALL_PROJECTS = "all";

export interface MemoryProjectOption {
  value: MemoryProjectFilter;
  label: string;
  count: number;
}

export function filterRows(
  rows: readonly MemoryRow[],
  query: string,
  project: MemoryProjectFilter = ALL_PROJECTS,
): MemoryRow[] {
  const inProject =
    project === ALL_PROJECTS ? [...rows] : rows.filter((row) => row.dirName === project);
  const needle = query.trim().toLowerCase();
  if (!needle) return inProject;
  return inProject.filter((row) =>
    [row.file.name, row.file.description, row.projectLabel]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

/**
 * One option per project that has memories, keeping the row order so the
 * active project stays on top of the dropdown too.
 */
export function projectOptions(rows: readonly MemoryRow[]): MemoryProjectOption[] {
  const seen = new Map<string, MemoryProjectOption>();
  for (const row of rows) {
    const existing = seen.get(row.dirName);
    if (existing) {
      existing.count += 1;
      continue;
    }
    seen.set(row.dirName, {
      value: row.dirName,
      label: row.isActiveProject
        ? `${shortLabel(row.projectLabel)} (current)`
        : shortLabel(row.projectLabel),
      count: 1,
    });
  }
  return [{ value: ALL_PROJECTS, label: "all projects", count: rows.length }, ...seen.values()];
}

/** Last path segment, so the dropdown is not a wall of absolute paths. */
function shortLabel(projectLabel: string): string {
  const parts = projectLabel.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? projectLabel;
}
