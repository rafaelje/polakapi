// Persistent chrome header: project + run-id on the left, chevron-shaped step
// breadcrumb in the middle, "abandon run" on the right. The step pills are
// click-to-navigate; if a scheduler is running we confirm before aborting it.

import { confirmModal } from "../../../shared/ui/modal";

import type { LoopRouter, LoopRouterState, LoopStep } from "../state/run-context";
import type { MountedStep } from "./types";

export function renderHeader(
  router: LoopRouter,
  state: Extract<LoopRouterState, { status: "active" }>,
  prev: MountedStep | null,
): HTMLElement {
  const header = document.createElement("header");
  header.className = "loop-header";

  // Left block: project + run-id
  const left = document.createElement("div");
  left.className = "loop-header-left";

  const projectName = document.createElement("span");
  projectName.className = "loop-header-project";
  projectName.textContent = state.project.name;
  projectName.title = state.project.path;

  const sep1 = document.createElement("span");
  sep1.className = "loop-header-sep";
  sep1.textContent = "·";

  const runLabel = document.createElement("span");
  runLabel.className = "loop-header-run";
  // Short run-id (8 chars of the UUID) in the chrome; the full id remains
  // accessible via `title` for copy-paste when debugging a run.
  runLabel.textContent = `run ${shortRunId(state.runId)}`;
  runLabel.title = state.runId;

  left.append(projectName, sep1, runLabel);

  // Middle block: step indicator (navigable). Each pill is a button that
  // changes the current step via the router. If a scheduler is running and
  // the user jumps to another step, we ask for confirmation because we
  // abort it.
  const steps = document.createElement("nav");
  steps.className = "loop-header-steps";
  steps.setAttribute("aria-label", "run steps");
  const schedulerLive =
    prev?.scheduler != null &&
    (prev.scheduler.getState().status === "running" ||
      prev.scheduler.getState().status === "paused");
  // Pill 4 is only enabled if there is a live scheduler (the user only
  // accesses step 4 via "▶ run" or by resuming an interrupted run).
  const hasScheduler = prev?.scheduler != null;
  for (const step of [1, 2, 3, 4] as const) {
    const isCurrent = step === state.step;
    const disabled = isCurrent || (step === 4 && !hasScheduler);
    steps.appendChild(
      renderStepPill(step, state.step, disabled, async () => {
        if (disabled) return;
        if (schedulerLive && state.step === 4 && step !== 4) {
          const ok = await confirmModal({
            title: "Leave the run in progress?",
            message:
              "A scheduler is running agents. If you go back to another step now, the agent in progress is aborted and the phase remains incomplete (resume can pick it up later).",
            confirmLabel: `go to step ${step}`,
            cancelLabel: "stay",
            danger: true,
          });
          if (!ok) return;
          prev?.scheduler?.abort();
        }
        router.setStep(step);
      }),
    );
  }

  // Right block: abandon
  const right = document.createElement("div");
  right.className = "loop-header-right";
  const abandon = document.createElement("button");
  abandon.type = "button";
  abandon.className = "loop-btn loop-btn-ghost";
  abandon.textContent = "abandon run";
  abandon.setAttribute("aria-label", "abandon current run");
  // Modal confirmation before discarding progress. The message adapts its
  // tone depending on whether there is a run in progress (live scheduler)
  // or only an empty run.
  abandon.addEventListener("click", () => {
    void (async () => {
      const live = schedulerLive;
      const ok = await confirmModal({
        title: live ? "Abandon run in progress?" : "Abandon run?",
        message: live
          ? "The scheduler is running. Abandoning aborts the current agent and discards unsaved progress. The persisted state.json stays on disk — you can resume it later from the banner."
          : "Discard the current run and start over. The persisted files stay on disk (you can browse them in `.loop/runs/`), but the chrome resets the chat / phases / setup buffers.",
        confirmLabel: live ? "abort and abandon" : "abandon",
        cancelLabel: "keep",
        danger: true,
      });
      if (!ok) return;
      // The router will pick up the new runId on its next refresh, but
      // first we abort the scheduler if any. The chrome's main file
      // persists the last state.json with status="aborted".
      if (prev?.scheduler) prev.scheduler.abort();
      router.abandonRun();
    })();
  });
  right.appendChild(abandon);

  header.append(left, steps, right);
  return header;
}

function renderStepPill(
  step: LoopStep,
  current: LoopStep,
  disabled: boolean,
  onClick: () => void | Promise<void>,
): HTMLElement {
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "loop-step-chevron";
  if (step === 1) pill.classList.add("loop-step-chevron-first");
  if (step === 4) pill.classList.add("loop-step-chevron-last");
  if (step === current) pill.classList.add("loop-step-chevron-current");
  else if (step < current) pill.classList.add("loop-step-chevron-done");
  else pill.classList.add("loop-step-chevron-future");

  const badge = document.createElement("span");
  badge.className = "loop-step-chevron-num";
  badge.textContent = `${step}`;
  badge.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "loop-step-chevron-label";
  label.textContent = stepShortLabel(step);

  pill.append(badge, label);
  pill.setAttribute("aria-current", step === current ? "step" : "false");
  pill.setAttribute("aria-label", `${stepLabel(step)}${step === current ? " (current)" : ""}`);
  pill.title = stepLabel(step);
  pill.disabled = disabled;
  pill.addEventListener("click", () => {
    void onClick();
  });
  return pill;
}

function stepLabel(step: LoopStep): string {
  switch (step) {
    case 1:
      return "Step 1 · problem intake";
    case 2:
      return "Step 2 · phase decomposition";
    case 3:
      return "Step 3 · run setup";
    case 4:
      return "Step 4 · execution";
  }
}

function stepShortLabel(step: LoopStep): string {
  switch (step) {
    case 1:
      return "Problem";
    case 2:
      return "Phases";
    case 3:
      return "Setup";
    case 4:
      return "Run";
  }
}

export function renderStepSlot(step: LoopStep): HTMLElement {
  const slot = document.createElement("section");
  slot.className = "loop-step-slot";
  slot.id = "loop-step-slot";
  slot.dataset.step = `${step}`;
  // Empty slot; steps 1–4 mount their content on top replacing the
  // children. If for some reason nobody mounts anything (inconsistent
  // state), the slot stays empty without confusing debug text.
  return slot;
}

export function shortRunId(id: string): string {
  // UUID v4: `xxxxxxxx-xxxx-...` — the first 8 chars give virtually zero
  // collision for the simultaneous runs the user will handle.
  return id.split("-")[0] ?? id.slice(0, 8);
}
