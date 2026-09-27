import type { ChangedFile, ChangeGroup, PinnedProject } from "./types";

export interface ChangesGroupView {
  group: ChangeGroup;
  label: string;
  files: ChangedFile[];
  count: number;
  insertions: number;
  deletions: number;
}

export type CodeReviewKeyAction =
  | "next"
  | "previous"
  | "refresh"
  | "close"
  | "toggle-stage"
  | "stage-all"
  | "discard";

export interface StagingAction {
  kind: "stage" | "unstage";
  paths: string[];
}

export interface KeyPress {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

const GROUP_LABELS: ReadonlyArray<[ChangeGroup, string]> = [
  ["staged", "Staged"],
  ["unstaged", "Unstaged"],
  ["untracked", "Untracked"],
];

const KEY_ACTIONS: Readonly<Record<string, CodeReviewKeyAction>> = {
  ArrowDown: "next",
  j: "next",
  ArrowUp: "previous",
  k: "previous",
  r: "refresh",
  Escape: "close",
  " ": "toggle-stage",
  a: "stage-all",
  d: "discard",
};

const WINDOW_URL = "code-review.html";

export function fileKey(file: Pick<ChangedFile, "group" | "path">): string {
  return `${file.group}:${file.path}`;
}

export function groupChanges(files: readonly ChangedFile[]): ChangesGroupView[] {
  return GROUP_LABELS.map(([group, label]) => {
    const members = files
      .filter((file) => file.group === group)
      .sort((a, b) => a.path.localeCompare(b.path));
    return {
      group,
      label,
      files: members,
      count: members.length,
      insertions: members.reduce((sum, file) => sum + file.insertions, 0),
      deletions: members.reduce((sum, file) => sum + file.deletions, 0),
    };
  });
}

export function visibleFileKeys(groups: readonly ChangesGroupView[]): string[] {
  return groups.flatMap((group) => group.files.map(fileKey));
}

export function moveSelection(
  keys: readonly string[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (keys.length === 0) return null;
  const index = current === null ? -1 : keys.indexOf(current);
  if (index === -1) return delta > 0 ? keys[0] : keys[keys.length - 1];
  const next = Math.min(keys.length - 1, Math.max(0, index + delta));
  return keys[next];
}

export function reconcileSelection(
  keys: readonly string[],
  previous: string | null,
): string | null {
  if (previous !== null && keys.includes(previous)) return previous;
  return keys[0] ?? null;
}

export function codeReviewKeyAction(press: KeyPress): CodeReviewKeyAction | null {
  if (press.ctrlKey || press.metaKey || press.altKey) return null;
  return KEY_ACTIONS[press.key] ?? null;
}

export function spaceAction(file: ChangedFile | null): StagingAction | null {
  if (!file) return null;
  if (file.group !== "staged") return { kind: "stage", paths: [file.path] };
  const paths = file.originalPath ? [file.path, file.originalPath] : [file.path];
  return { kind: "unstage", paths };
}

export function buildCodeReviewUrl(project: PinnedProject): string {
  const params = new URLSearchParams({ project: project.path, name: project.name });
  return `${WINDOW_URL}?${params.toString()}`;
}

export function readPinnedProject(search: string): PinnedProject | null {
  const params = new URLSearchParams(search);
  const path = params.get("project");
  if (!path) return null;
  const name = params.get("name") || folderName(path);
  return { path, name };
}

export function codeReviewWindowLabel(projectPath: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < projectPath.length; index += 1) {
    hash ^= projectPath.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `code-review-${(hash >>> 0).toString(16)}`;
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
