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

export interface BranchFile {
  path: string;
  originalPath: string | null;
  status: ChangeStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface BranchOverview {
  base: string;
  mergeBase: string;
  files: BranchFile[];
}

export type ContentSource =
  | { kind: "staged" }
  | { kind: "unstaged" }
  | { kind: "untracked" }
  | { kind: "branch"; base: string };

export interface DiffTarget {
  key: string;
  path: string;
  originalPath: string | null;
  status: ChangeStatus;
  source: ContentSource;
}

export type SideContent =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "binary" }
  | { kind: "tooLarge"; bytes: number };

export interface FileContents {
  before: SideContent;
  after: SideContent;
}

export interface ReviewFolder {
  branch: string;
  folder: string;
}

export type Verdict = "go" | "no-go" | "pending";

export interface ReviewProcess {
  number: string;
  slug: string;
  markdown: string | null;
  html: string | null;
  verdict: Verdict;
}

export interface ReviewProcesses extends ReviewFolder {
  processes: ReviewProcess[];
  index: string | null;
}
