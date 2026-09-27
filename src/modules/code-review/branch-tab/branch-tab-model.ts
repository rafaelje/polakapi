import type { BranchFile, BranchRefs, DiffTarget } from "../types";

export const BASE_PLACEHOLDER = "select the base branch for the diff";

export type BranchListView = "files" | "processes";

export interface BaseOptionGroup {
  label: string;
  options: string[];
}

export interface BranchFileGroup {
  group: "branch";
  label: string;
  files: BranchFile[];
  keys: string[];
  count: number;
}

export function baseOptionGroups(refs: BranchRefs, selected: string | null): BaseOptionGroup[] {
  const remote = refs.remote.map((branch) => branch.name);
  const local = [...refs.local];
  if (selected && !local.includes(selected) && !remote.includes(selected)) {
    local.push(selected);
    local.sort((a, b) => a.localeCompare(b));
  }
  return [
    { label: "Local", options: local },
    { label: "Remote", options: remote },
  ].filter((group) => group.options.length > 0);
}

export function resolveBase(chosen: string | null, defaultBase: string | null): string | null {
  return chosen ?? defaultBase;
}

export function listViewFrom(value: string | undefined): BranchListView {
  return value === "processes" ? "processes" : "files";
}

export function branchFileKey(file: Pick<BranchFile, "path">): string {
  return `branch:${file.path}`;
}

export function branchFileGroup(files: readonly BranchFile[], base: string): BranchFileGroup {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return {
    group: "branch",
    label: `vs ${base}`,
    files: sorted,
    keys: sorted.map(branchFileKey),
    count: sorted.length,
  };
}

export function branchFileTarget(file: BranchFile, base: string): DiffTarget {
  return {
    key: branchFileKey(file),
    path: file.path,
    originalPath: file.originalPath,
    status: file.status,
    source: { kind: "branch", base },
  };
}
