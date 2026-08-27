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

export function filterRows(rows: readonly MemoryRow[], query: string): MemoryRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) =>
    [row.file.name, row.file.description, row.projectLabel]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}
