import type { AgentPanel } from "../agent/agent-panel";
import { prepareReviewFolder } from "../api";
import { el } from "../dom";
import { mountModelSelect } from "../model-select";
import { buildReviewPrompt, type ReviewStep } from "./review-prompts";
import {
  clearsReviewFolder,
  reviewersModelOverride,
  reviewersModelValue,
} from "./review-run-model";
import { stringifyError } from "../../../shared/errors";

export type ReviewAgent = Pick<AgentPanel, "selection" | "onSelectionChange" | "write">;

export interface ReviewRunOptions {
  projectPath: string;
  agent: ReviewAgent;
  baseBranch(): string | null;
  onStarted(): void;
}

export interface ReviewRun {
  element: HTMLElement;
  update(): void;
}

const NO_BASE = "Select the base branch first.";

const STEPS: ReadonlyArray<[ReviewStep, string, string]> = [
  ["step1", "Step 1", "Split the branch into Processes as pseudo-code"],
  ["step2", "Step 2", "Review each Process and write its Verdict report"],
  ["both", "Both", "Run Step 1 and then Step 2"],
];

export function mountReviewRun(options: ReviewRunOptions): ReviewRun {
  const { agent } = options;
  const element = el("div", "code-review-run");
  const buttons = el("div", "code-review-run-buttons");
  const modelSelect = mountModelSelect(
    "code-review-run-model",
    "Reviewers' model",
    "Reviewers: same as the agent",
  );
  const status = el("p", "code-review-run-status code-review-muted");
  status.setAttribute("role", "status");
  const stepButtons: Array<[HTMLButtonElement, string]> = [];
  let override: string | null = null;
  let busy = false;

  const update = (): void => {
    const hasBase = options.baseBranch() !== null;
    for (const [button, title] of stepButtons) {
      button.disabled = busy || !hasBase;
      button.title = hasBase ? title : NO_BASE;
    }
  };

  const setStatus = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle("code-review-error", isError);
  };

  const run = async (step: ReviewStep): Promise<void> => {
    const base = options.baseBranch();
    if (!base) {
      setStatus(NO_BASE, true);
      return;
    }
    busy = true;
    element.classList.add("is-busy");
    update();
    try {
      const folder = await prepareReviewFolder(options.projectPath, clearsReviewFolder(step));
      const { cli, model } = agent.selection();
      const reviewersModel = reviewersModelValue(override, model);
      const prompt = buildReviewPrompt({ step, cli, base, ...folder, reviewersModel });
      if (!(await agent.write(prompt))) {
        setStatus("The agent terminal is not running; restart it and try again.", true);
        return;
      }
      setStatus(`Sent to ${cli} · ${folder.folder}`);
      options.onStarted();
    } catch (cause) {
      setStatus(`Could not start the review: ${stringifyError(cause)}`, true);
    } finally {
      busy = false;
      element.classList.remove("is-busy");
      update();
    }
  };

  for (const [step, label, title] of STEPS) {
    const button = el("button", "code-review-btn", label);
    button.type = "button";
    button.title = title;
    button.addEventListener("click", () => {
      if (!busy) void run(step);
    });
    stepButtons.push([button, title]);
    buttons.append(button);
  }
  modelSelect.element.addEventListener("change", () => {
    override = reviewersModelOverride(modelSelect.element.value, agent.selection().model);
    if (override === null) modelSelect.element.value = "";
  });
  let cli = agent.selection().cli;
  agent.onSelectionChange((selection) => {
    if (selection.cli === cli) return;
    override = null;
    cli = selection.cli;
    modelSelect.load(cli, "");
  });
  modelSelect.load(cli, "");
  buttons.append(modelSelect.element);
  element.append(buttons, status);
  update();
  return { element, update };
}
