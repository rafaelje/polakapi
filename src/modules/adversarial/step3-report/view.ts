// Step 3 UI: verdict banner + rendered report + open-in-editor/explorer.

import { invoke } from "@tauri-apps/api/core";
import { computeVerdict, renderReport } from "../core/report";
import { buildRunFilePath, type DebateState } from "../types";

export interface Step3Config {
  state: DebateState;
  onNewReview(): void;
}

export function mountStep3Report(slot: HTMLElement, config: Step3Config): { dispose(): void } {
  slot.replaceChildren();
  const root = document.createElement("div");
  root.className = "adv-content";
  slot.appendChild(root);

  const { state } = config;
  const summary = computeVerdict(state.findings, state.settings.blockingSeverity);
  const reportMd = renderReport(state);

  const verdictCard = document.createElement("section");
  verdictCard.className = `adv-verdict ${summary.verdict === "APPROVED" ? "approved" : "blocked"}`;
  verdictCard.textContent =
    summary.verdict === "APPROVED"
      ? `✅ APPROVED (blocking threshold: ${summary.blockingSeverity})`
      : `🚫 CHANGES REQUESTED — ${summary.confirmedBlocking.length} confirmed ≥ ${summary.blockingSeverity}`;

  const counters = document.createElement("div");
  counters.className = "adv-counters";
  const stats = {
    confirmed: summary.confirmedBlocking.length + summary.confirmedNonBlocking.length,
    disputed: summary.disputed.length,
    withdrawn: summary.withdrawnCount,
  };
  for (const [k, v] of Object.entries(stats)) {
    const c = document.createElement("span");
    c.className = "adv-counter";
    c.innerHTML = `${k}: <strong>${v}</strong>`;
    counters.appendChild(c);
  }

  const actions = document.createElement("div");
  actions.className = "adv-actions";
  const openEditor = document.createElement("button");
  openEditor.type = "button";
  openEditor.className = "adv-btn";
  openEditor.textContent = "open report in editor";
  openEditor.addEventListener("click", () => {
    void invoke("open_file_in_editor", {
      path: buildRunFilePath(state.settings.projectPath, state.settings.runId, "report.md"),
    }).catch((err) => console.error("open report failed", err));
  });
  const openFolder = document.createElement("button");
  openFolder.type = "button";
  openFolder.className = "adv-btn";
  openFolder.textContent = "open run folder";
  openFolder.addEventListener("click", () => {
    const runDir = buildRunFilePath(state.settings.projectPath, state.settings.runId, "");
    void invoke("open_in_explorer", { path: runDir.replace(/\/$/, "") }).catch((err) =>
      console.error("open folder failed", err),
    );
  });
  const newReview = document.createElement("button");
  newReview.type = "button";
  newReview.className = "adv-btn primary";
  newReview.textContent = "new review";
  newReview.addEventListener("click", () => config.onNewReview());
  actions.append(openEditor, openFolder, newReview);

  const reportBody = document.createElement("pre");
  reportBody.className = "adv-report-body";
  reportBody.textContent = reportMd;

  root.append(verdictCard, counters, actions, reportBody);

  return { dispose: () => {} };
}
