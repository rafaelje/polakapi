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

export interface RemoteBranch {
  name: string;
  remote: string;
  branch: string;
}

export interface BranchRefs {
  current: string | null;
  local: string[];
  remote: RemoteBranch[];
}

export interface PinnedProject {
  path: string;
  name: string;
}

export type CodeReviewTab = "changes" | "branch";

export type ContentSource = { kind: "staged" } | { kind: "unstaged" } | { kind: "untracked" };

export type SideContent =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "binary" }
  | { kind: "tooLarge"; bytes: number };

export interface FileContents {
  before: SideContent;
  after: SideContent;
}
