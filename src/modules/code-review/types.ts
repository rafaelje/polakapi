export type ChangeGroup = "staged" | "unstaged" | "untracked";

export type ChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

export interface ChangedFile {
  path: string;
  originalPath: string | null;
  group: ChangeGroup;
  status: ChangeStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface ChangesOverview {
  branch: string | null;
  files: ChangedFile[];
}

export interface PinnedProject {
  path: string;
  name: string;
}

export type CodeReviewTab = "changes" | "branch";
