import type { AgentCli } from "../../../shared/agent-cli";

export type ReviewStep = "step1" | "step2" | "both";

export interface ReviewPromptInput {
  step: ReviewStep;
  cli: AgentCli;
  branch: string;
  base: string;
  folder: string;
  reviewersModel: string;
}

const WRITE_ONLY = "Only write those files; do not modify anything else in the repository.";

const ORCHESTRATION: Record<AgentCli, string | null> = {
  claude: "create a multi-agent Workflow with one reviewer agent per process, running in parallel",
  codex: "launch multiple agents with one reviewer agent per process, running in parallel",
  opencode: null,
  cursor: null,
};

function step1(input: ReviewPromptInput): string[] {
  const { branch, base, folder } = input;
  return [
    `Analyze in detail the changes in this branch (${branch}) against ${base} (use \`git diff ${base}...HEAD\`) ` +
      "and write, in pseudo-code, each process that has changes, one independent file per process " +
      `inside ${folder}/, named 1.1-<process-a>.md, 1.2-<process-b>.md, etc., ` +
      "where <process-x> is a short kebab-case name for the process.",
    "End each process file with a `Files` list of the hunks the process touches, as <path>:<start>-<end> " +
      "on this branch's side, and a `Database` line naming the tables, columns, indexes or relations it adds, " +
      "changes or removes (migrations, schema files, models or queries), or `none`.",
  ];
}

function reviewers(input: ReviewPromptInput): string {
  const sources = `Using the pseudo-code processes in ${input.folder}/ (the N.N-<process>.md files)`;
  const target = `to do a code review of this branch (${input.branch}).`;
  const orchestration = ORCHESTRATION[input.cli];
  if (!orchestration) {
    return `${sources}, review the processes one by one, sequentially, in this session, ${target}`;
  }
  const model = input.reviewersModel.trim();
  const modelText = model ? `the model ${model}` : "the same model as this session";
  return `${sources} and ${modelText} for the reviewer agents, ${orchestration}, ${target}`;
}

function diagram(cli: AgentCli): string {
  return cli === "claude"
    ? "made with the /diagram-design skill and embedded in the HTML; " +
        "if that skill is unavailable or fails, draw it with Mermaid inside the HTML"
    : "drawn with Mermaid inside the HTML";
}

function step2(input: ReviewPromptInput): string[] {
  const { branch, base, folder } = input;
  return [
    reviewers(input),
    "There are multiple processes defined as pseudo-code; analyze each independent process and give " +
      `a GO / NO-GO as a senior software engineer for integrating each process into ${base}.`,
    "Review good practices, security and maintainability; don't over-engineer, we want simple processes; " +
      "analyze the happy path with minimal edge cases.",
    `For each process write ${folder}/N.N-<process>.html, with the same N.N-<process> name ` +
      "as its .md file, containing:",
    "- the Verdict (GO or NO-GO) with its reasons",
    "- the findings on good practices, security and maintainability",
    "- the Big O time and space complexity",
    "- the pseudo-code of the process",
    `- the diffs of the process: every hunk listed in its \`Files\`, complete, from \`git diff ${base}...HEAD\``,
    `- an architecture diagram of what the process adds or changes, ${diagram(input.cli)}`,
    "- a database diagram drawn as a Mermaid erDiagram inside the HTML with the tables, columns and relations " +
      'the process adds, changes or removes, or the text "No database changes" when its `Database` line is `none`',
    `Show the diffs as clearly as VS Code or lazygit: a header naming this branch (${branch}) and the base branch ` +
      `(${base}) it is compared against; one block per file headed by its path and status (modified, added, ` +
      "deleted or renamed from); every hunk complete with its @@ header; old and new line numbers on every line; " +
      "added lines marked + on a green background, removed lines marked - on a red background, context lines neutral; " +
      "HTML-escaped monospace text that scrolls horizontally instead of wrapping. Never show hunks of another process.",
    "Load Mermaid in every HTML that uses it so the diagrams render when the file is opened in a browser.",
    'In the <head> of each process HTML declare its Verdict exactly as <meta name="verdict" content="GO"> ' +
      `or <meta name="verdict" content="NO-GO">, and the base branch as <meta name="base" content="${base}">.`,
    `When every process is reviewed, write ${folder}/index.html summarizing every process ` +
      "with its Verdict and a link to its HTML file.",
  ];
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  switch (input.step) {
    case "step1":
      return [...step1(input), WRITE_ONLY].join("\n");
    case "step2":
      return [...step2(input), WRITE_ONLY].join("\n");
    case "both":
      return [
        "Do this code review in two steps, finishing Step 1 before starting Step 2.",
        "",
        "Step 1:",
        ...step1(input),
        "",
        "Step 2:",
        ...step2(input),
        "",
        WRITE_ONLY,
      ].join("\n");
  }
}
