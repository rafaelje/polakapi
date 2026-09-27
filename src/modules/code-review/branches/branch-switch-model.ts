import type { BranchRefs, ChangedFile } from "../types";

export interface BranchSwitchOption {
  ref: string;
  label: string;
  current: boolean;
}

export interface BranchSwitchGroup {
  label: string;
  options: BranchSwitchOption[];
}

export function switchBlockReason(files: readonly ChangedFile[]): string | null {
  const count = new Set(files.map((file) => file.path)).size;
  if (count === 0) return null;
  const noun = count === 1 ? "file" : "files";
  return `Commit or discard your ${count} changed ${noun} before switching branches.`;
}

export function branchSwitchGroups(refs: BranchRefs, filter: string): BranchSwitchGroup[] {
  const needle = filter.trim().toLowerCase();
  const matches = (name: string): boolean => name.toLowerCase().includes(needle);
  const local = new Set(refs.local);
  const groups: BranchSwitchGroup[] = [
    {
      label: "Local",
      options: refs.local
        .filter(matches)
        .map((name) => ({ ref: name, label: name, current: name === refs.current })),
    },
    {
      label: "Remote",
      options: refs.remote
        .filter((remote) => !local.has(remote.branch) && matches(remote.name))
        .map((remote) => ({ ref: remote.name, label: remote.name, current: false })),
    },
  ];
  return groups.filter((group) => group.options.length > 0);
}
