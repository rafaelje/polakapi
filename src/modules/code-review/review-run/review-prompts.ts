import type { AgentCli } from "../../../shared/agent-cli";

export type ReviewStep = "step1";

export interface ReviewPromptInput {
  step: ReviewStep;
  cli: AgentCli;
  branch: string;
  base: string;
  folder: string;
  reviewersModel: string;
}

function step1(input: ReviewPromptInput): string[] {
  const { branch, base, folder } = input;
  return [
    `Analyze in detail the changes in this branch (${branch}) against ${base} (use \`git diff ${base}...HEAD\`) ` +
      "and write, in pseudo-code, each process that has changes, one independent file per process " +
      `inside ${folder}/, named 1.1-<process-a>.md, 1.2-<process-b>.md, etc., ` +
      "where <process-x> is a short kebab-case name for the process.",
    "Only write those files; do not modify anything else in the repository.",
  ];
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  return step1(input).join("\n");
}
