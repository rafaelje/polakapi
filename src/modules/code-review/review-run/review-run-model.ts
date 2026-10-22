import type { ReviewProcess, ReviewProcesses, Verdict } from "../types";
import type { ReviewStep } from "./review-prompts";

export type ProcessesState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | ({ kind: "loaded" } & ReviewProcesses);

export type VerdictBadge = "GO" | "NO-GO" | "pending";

export interface ProcessRow {
  key: string;
  label: string;
  badge: VerdictBadge;
  file: string | null;
  pseudoCode: string | null;
}

export interface ReportFile {
  file: string;
  path: string;
}

export interface ReportTarget extends ReportFile {
  label: string;
  pseudoCode: ReportFile | null;
}

export const INDEX_KEY = "index";

const BADGES: Record<Verdict, VerdictBadge> = {
  go: "GO",
  "no-go": "NO-GO",
  pending: "pending",
};

export function clearsReviewFolder(step: ReviewStep): boolean {
  return step !== "step2";
}

export function processesMessage(state: ProcessesState): string | null {
  if (state.kind === "loading") return "Loading processes…";
  if (state.kind === "error") return state.message;
  return state.processes.length === 0 ? "No review run yet" : null;
}

export function processRows(processes: readonly ReviewProcess[]): ProcessRow[] {
  return processes.map((process) => ({
    key: `${process.number}-${process.slug}`,
    label: `${process.number} ${process.slug}`,
    badge: BADGES[process.verdict],
    file: process.html ?? process.markdown,
    pseudoCode: process.html ? process.markdown : null,
  }));
}

export function reviewersModelValue(override: string | null, terminalModel: string): string {
  return override ?? terminalModel;
}

export function reviewersModelOverride(typed: string, terminalModel: string): string | null {
  const model = typed.trim();
  return model === "" || model === terminalModel ? null : model;
}

export function selectedReport(
  key: string | null,
  state: ProcessesState,
  projectPath: string,
): ReportTarget | null {
  if (key === null || state.kind !== "loaded") return null;
  const located = (file: string): ReportFile => ({
    file,
    path: reportPath(projectPath, state.folder, file),
  });
  const target = (label: string, file: string | null, pseudoCode: string | null) =>
    file ? { label, ...located(file), pseudoCode: pseudoCode ? located(pseudoCode) : null } : null;
  if (key === INDEX_KEY) return target(INDEX_KEY, state.index, null);
  const row = processRows(state.processes).find((entry) => entry.key === key);
  return row ? target(row.label, row.file, row.pseudoCode) : null;
}

export function reconcileProcess(key: string | null, state: ProcessesState): string | null {
  if (key === null || state.kind !== "loaded") return key;
  return selectedReport(key, state, "") ? key : null;
}

export function reportPath(projectPath: string, folder: string, file: string): string {
  const separator = projectPath.includes("\\") && !projectPath.includes("/") ? "\\" : "/";
  const root = projectPath.replace(/[\\/]+$/, "");
  return [root, ...folder.split("/"), file].join(separator);
}
