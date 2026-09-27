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
}

const BADGES: Record<Verdict, VerdictBadge> = {
  go: "GO",
  "no-go": "NO-GO",
  pending: "pending",
};

export function clearsReviewFolder(step: ReviewStep): boolean {
  return step === "step1";
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
  }));
}
