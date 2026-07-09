// Adversarial-window chrome: gate, header, step slot. Mirrors the /loop
// chrome but simpler — only 3 steps and no resume banner in v1.

import { showToast } from "../../shared/ui/toast";
import { stringifyError } from "../../shared/errors";
import type { AdvRouter } from "./run-context";
import { type AdvRouterState } from "./run-context";
import { DebateScheduler } from "./scheduler/debate-scheduler";
import { invokers } from "./scheduler/invokers";
import { mountStep1Setup } from "./step1-setup/view";
import { mountStep2Run } from "./step2-run/view";
import { mountStep3Report } from "./step3-report/view";
import type { DebateSettings, DebateState } from "./types";

export interface AdvChromeHandle {
  dispose(): void;
}

export function mountAdversarialChrome(root: HTMLElement, router: AdvRouter): AdvChromeHandle {
  let currentDispose: (() => void) | null = null;
  let currentScheduler: DebateScheduler | null = null;
  let finalState: DebateState | null = null;

  const disposeStep = (): void => {
    currentDispose?.();
    currentDispose = null;
  };

  const abortScheduler = (): void => {
    if (currentScheduler) {
      currentScheduler.requestAbort();
    }
  };

  const startDebate = async (
    settings: DebateSettings,
    diff: string,
    diffTruncated: boolean,
  ): Promise<void> => {
    try {
      await invokers.createRun(settings.projectPath, settings.runId).catch((err) => {
        // If the run dir already exists (rare — same UUID collision after a
        // fresh window open), let the caller know; otherwise treat as fatal.
        const s = String(err);
        if (!s.includes("already exists")) throw err;
      });
      await invokers.writeRunFile(settings.projectPath, settings.runId, "diff.patch", diff);
    } catch (err) {
      showToast(`could not initialize run: ${stringifyError(err)}`, "error");
      return;
    }

    const initial = DebateScheduler.seedState(settings, diff, diffTruncated);
    const scheduler = new DebateScheduler(initial, { invokers, now: () => Date.now() });
    currentScheduler = scheduler;
    finalState = null;
    router.setStep(2);
    // The scheduler.start() runs the whole debate; step 2 view subscribes to
    // its store updates. The promise is intentionally voided.
    void scheduler
      .start(diff)
      .then((state) => {
        finalState = state;
      })
      .catch((err) => {
        console.error("adversarial: scheduler crashed", err);
        showToast(`debate crashed: ${stringifyError(err)}`, "error");
      });
  };

  const rerender = (state: AdvRouterState): void => {
    disposeStep();

    if (state.status === "loading") {
      root.replaceChildren(renderGate("loading…", null));
      return;
    }
    if (state.status === "no-project") {
      root.replaceChildren(
        renderGate(
          "Pick a project first",
          "/adversarial review operates on the workspace's active project. Open the main window and select one to start.",
        ),
      );
      return;
    }
    if (state.status === "invalid-path") {
      root.replaceChildren(renderErrorGate("Invalid path", state.project.name, state.project.path));
      return;
    }

    // active
    const shell = document.createElement("div");
    shell.className = "adv-shell";
    shell.appendChild(renderHeader(state));
    const slot = document.createElement("div");
    slot.className = "adv-slot";
    slot.style.flex = "1 1 auto";
    slot.style.minHeight = "0";
    slot.style.overflow = "hidden";
    slot.style.display = "flex";
    slot.style.flexDirection = "column";
    shell.appendChild(slot);
    root.replaceChildren(shell);

    if (state.step === 1) {
      abortScheduler();
      currentScheduler = null;
      const handle = mountStep1Setup(slot, {
        projectPath: state.project.path,
        projectName: state.project.name,
        runId: state.runId,
        onExecute: (settings, diff, truncated) => {
          void startDebate(settings, diff, truncated);
        },
      });
      currentDispose = () => handle.dispose();
      return;
    }

    if (state.step === 2) {
      if (!currentScheduler) {
        // Fallback: the user reloaded the page mid-run — send them back to step 1.
        router.setStep(1);
        return;
      }
      const scheduler = currentScheduler;
      const handle = mountStep2Run(slot, {
        scheduler,
        onDone: (final) => {
          finalState = final;
          router.setStep(3);
        },
        onAbort: () => scheduler.requestAbort(),
      });
      currentDispose = () => handle.dispose();
      return;
    }

    // step 3
    const state3 = finalState ?? currentScheduler?.getState() ?? null;
    if (!state3) {
      router.setStep(1);
      return;
    }
    const handle = mountStep3Report(slot, {
      state: state3,
      onNewReview: () => {
        router.freshRun();
      },
    });
    currentDispose = () => handle.dispose();
  };

  const unsubscribe = router.on(rerender);

  return {
    dispose: () => {
      unsubscribe();
      disposeStep();
      abortScheduler();
    },
  };
}

function renderHeader(state: Extract<AdvRouterState, { status: "active" }>): HTMLElement {
  const header = document.createElement("div");
  header.className = "adv-header";
  const title = document.createElement("span");
  title.className = "adv-header-title";
  title.textContent = "/adversarial review";
  header.appendChild(title);
  const labels: Record<number, string> = { 1: "setup", 2: "run", 3: "report" };
  for (const step of [1, 2, 3] as const) {
    const chip = document.createElement("span");
    chip.className = "adv-step-chip" + (state.step === step ? " active" : "");
    chip.textContent = `${step}. ${labels[step]}`;
    header.appendChild(chip);
  }
  const banner = document.createElement("span");
  banner.className = "adv-project-banner";
  banner.textContent = `${state.project.name} — ${state.project.path}`;
  header.appendChild(banner);
  return header;
}

function renderGate(title: string, msg: string | null): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "adv-gate";
  const h = document.createElement("h2");
  h.textContent = title;
  wrap.appendChild(h);
  if (msg) {
    const p = document.createElement("p");
    p.textContent = msg;
    wrap.appendChild(p);
  }
  return wrap;
}

function renderErrorGate(title: string, name: string, path: string): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "adv-gate error";
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = `Project "${name}" points to a path that does not exist or is not accessible.`;
  const code = document.createElement("code");
  code.textContent = path;
  wrap.append(h, p, code);
  return wrap;
}
