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
  report: string | null;
}

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
    report: process.html,
  }));
}

export function reviewersModelValue(override: string | null, terminalModel: string): string {
  return override ?? terminalModel;
}

export function reviewersModelOverride(typed: string, terminalModel: string): string | null {
  const model = typed.trim();
  return model === "" || model === terminalModel ? null : model;
}

export function reconcileReport(open: string | null, state: ProcessesState): string | null {
  if (open === null || state.kind !== "loaded") return open;
  const exists = open === state.index || state.processes.some((process) => process.html === open);
  return exists ? open : null;
}
