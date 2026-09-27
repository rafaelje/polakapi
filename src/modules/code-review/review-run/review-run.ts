import type { AgentPanel } from "../agent/agent-panel";
import { describeError, prepareReviewFolder } from "../api";
import { el } from "../dom";
import { buildReviewPrompt, type ReviewStep } from "./review-prompts";
import { clearsReviewFolder } from "./review-run-model";

export type ReviewAgent = Pick<AgentPanel, "selection" | "write">;

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
];

export function mountReviewRun(options: ReviewRunOptions): ReviewRun {
  const element = el("div", "code-review-run");
  const buttons = el("div", "code-review-run-buttons");
  const status = el("p", "code-review-run-status code-review-muted");
  status.setAttribute("role", "status");
  let busy = false;

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
      const { cli, model } = options.agent.selection();
      const prompt = buildReviewPrompt({ step, cli, base, ...folder, reviewersModel: model });
      const sent = await options.agent.write(prompt);
      if (!sent) {
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
  element.append(buttons, status);
  return { element };
}
