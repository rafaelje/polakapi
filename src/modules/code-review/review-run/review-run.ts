import type { AgentPanel } from "../agent/agent-panel";
import { describeError, prepareReviewFolder } from "../api";
import { el } from "../dom";
import { buildReviewPrompt, type ReviewStep } from "./review-prompts";
import {
  clearsReviewFolder,
  reviewersModelOverride,
  reviewersModelValue,
} from "./review-run-model";

export type ReviewAgent = Pick<AgentPanel, "selection" | "onSelectionChange" | "write">;

export interface ReviewRunOptions {
  projectPath: string;
  agent: ReviewAgent;
  baseBranch(): string | null;
  onStarted(): void;
}

export interface ReviewRun {
  element: HTMLElement;
}

const STEPS: ReadonlyArray<[ReviewStep, string, string]> = [
  ["step1", "Step 1", "Split the branch into Processes as pseudo-code"],
  ["step2", "Step 2", "Review each Process and write its Verdict report"],
  ["both", "Both", "Run Step 1 and then Step 2"],
];

export function mountReviewRun(options: ReviewRunOptions): ReviewRun {
  const { agent } = options;
  const element = el("div", "code-review-run");
  const buttons = el("div", "code-review-run-buttons");
  const modelInput = el("input", "code-review-run-model");
  modelInput.type = "text";
  modelInput.spellcheck = false;
  modelInput.title = "Reviewers' model (defaults to the agent terminal's model)";
  modelInput.setAttribute("aria-label", "Reviewers' model");
  const status = el("p", "code-review-run-status code-review-muted");
  status.setAttribute("role", "status");
  let override: string | null = null;
  let busy = false;

  const syncModel = (): void => {
    const terminalModel = agent.selection().model;
    modelInput.placeholder = terminalModel || "reviewers' model";
    modelInput.value = reviewersModelValue(override, terminalModel);
  };

  const setStatus = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle("code-review-error", isError);
  };

  const run = async (step: ReviewStep): Promise<void> => {
    const base = options.baseBranch();
    if (!base) {
      setStatus("Select the base branch first.", true);
      return;
    }
    busy = true;
    element.classList.add("is-busy");
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
      setStatus(`Could not start the review: ${describeError(cause)}`, true);
    } finally {
      busy = false;
      element.classList.remove("is-busy");
    }
  };

  for (const [step, label, title] of STEPS) {
    const button = el("button", "code-review-btn", label);
    button.type = "button";
    button.title = title;
    button.addEventListener("click", () => {
      if (!busy) void run(step);
    });
    buttons.append(button);
  }
  modelInput.addEventListener("change", () => {
    override = reviewersModelOverride(modelInput.value, agent.selection().model);
    syncModel();
  });
  let cli = agent.selection().cli;
  agent.onSelectionChange((selection) => {
    if (selection.cli !== cli) override = null;
    cli = selection.cli;
    syncModel();
  });
  syncModel();
  buttons.append(modelInput);
  element.append(buttons, status);
  return { element };
}
