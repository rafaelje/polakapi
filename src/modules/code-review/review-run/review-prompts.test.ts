import { describe, expect, it } from "vitest";
import { buildReviewPrompt, type ReviewPromptInput } from "./review-prompts";

const input: ReviewPromptInput = {
  step: "step1",
  cli: "claude",
  branch: "feat/login",
  base: "main",
  folder: "docs/code-review/feat-login",
  reviewersModel: "claude-sonnet-4-6",
};

describe("buildReviewPrompt step 1", () => {
  it("asks for one pseudo-code file per process with the naming contract", () => {
    expect(buildReviewPrompt(input)).toBe(
      [
        "Analyze in detail the changes in this branch (feat/login) against main (use `git diff main...HEAD`) " +
          "and write, in pseudo-code, each process that has changes, one independent file per process " +
          "inside docs/code-review/feat-login/, named 1.1-<process-a>.md, 1.2-<process-b>.md, etc., " +
          "where <process-x> is a short kebab-case name for the process.",
        "End each process file with a `Files` list of the hunks the process touches, as <path>:<start>-<end> " +
          "on this branch's side, and a `Database` line naming the tables, columns, indexes or relations it adds, " +
          "changes or removes (migrations, schema files, models or queries), or `none`.",
        "Only write those files; do not modify anything else in the repository.",
      ].join("\n"),
    );
  });

  it("is the same for every CLI", () => {
    const claude = buildReviewPrompt(input);
    for (const cli of ["codex", "opencode", "cursor"] as const) {
      expect(buildReviewPrompt({ ...input, cli })).toBe(claude);
    }
  });

  it("names the chosen base branch and folder", () => {
    const prompt = buildReviewPrompt({
      ...input,
      branch: "fix/a",
      base: "origin/develop",
      folder: "docs/code-review/fix-a",
    });

    expect(prompt).toContain("this branch (fix/a) against origin/develop");
    expect(prompt).toContain("`git diff origin/develop...HEAD`");
    expect(prompt).toContain("inside docs/code-review/fix-a/");
  });
});

const CLAUDE_STEP2 = [
  "Using the pseudo-code processes in docs/code-review/feat-login/ (the N.N-<process>.md files) " +
    "and the model claude-sonnet-4-6 for the reviewer agents, create a multi-agent Workflow " +
    "with one reviewer agent per process, running in parallel, to do a code review of this branch (feat/login).",
  "There are multiple processes defined as pseudo-code; analyze each independent process and give " +
    "a GO / NO-GO as a senior software engineer for integrating each process into main.",
  "Review good practices, security and maintainability; don't over-engineer, we want simple processes; " +
    "analyze the happy path with minimal edge cases.",
  "For each process write docs/code-review/feat-login/N.N-<process>.html, with the same N.N-<process> name " +
    "as its .md file, containing:",
  "- the Verdict (GO or NO-GO) with its reasons",
  "- the findings on good practices, security and maintainability",
  "- the Big O time and space complexity",
  "- the pseudo-code of the process",
  "- the diffs of the process: every hunk listed in its `Files`, complete, from `git diff main...HEAD`",
  "- an architecture diagram of what the process adds or changes, made with the /diagram-design skill " +
    "and embedded in the HTML; if that skill is unavailable or fails, draw it with Mermaid inside the HTML",
  "- a database diagram drawn as a Mermaid erDiagram inside the HTML with the tables, columns and relations " +
    'the process adds, changes or removes, or the text "No database changes" when its `Database` line is `none`',
  "Show the diffs as clearly as VS Code or lazygit: a header naming this branch (feat/login) and the base branch " +
    "(main) it is compared against; one block per file headed by its path and status (modified, added, " +
    "deleted or renamed from); every hunk complete with its @@ header; old and new line numbers on every line; " +
    "added lines marked + on a green background, removed lines marked - on a red background, context lines neutral; " +
    "HTML-escaped monospace text that scrolls horizontally instead of wrapping. Never show hunks of another process.",
  "Load Mermaid in every HTML that uses it so the diagrams render when the file is opened in a browser.",
  'In the <head> of each process HTML declare its Verdict exactly as <meta name="verdict" content="GO"> ' +
    'or <meta name="verdict" content="NO-GO">, and the base branch as <meta name="base" content="main">.',
  "When every process is reviewed, write docs/code-review/feat-login/index.html summarizing every process " +
    "with its Verdict and a link to its HTML file.",
  "Only write those files; do not modify anything else in the repository.",
].join("\n");

describe("buildReviewPrompt step 2", () => {
  it("asks claude for a parallel Workflow, diagram-design and the exact file contract", () => {
    expect(buildReviewPrompt({ ...input, step: "step2" })).toBe(CLAUDE_STEP2);
  });

  it("asks codex for parallel agents with the reviewers' model and a Mermaid diagram", () => {
    const prompt = buildReviewPrompt({
      ...input,
      step: "step2",
      cli: "codex",
      reviewersModel: "gpt-5.5",
    });

    expect(prompt).toContain(
      "and the model gpt-5.5 for the reviewer agents, launch multiple agents " +
        "with one reviewer agent per process, running in parallel, to do a code review",
    );
    expect(prompt).toContain(
      "- an architecture diagram of what the process adds or changes, drawn with Mermaid inside the HTML\n",
    );
    expect(prompt).not.toContain("diagram-design");
  });

  it("asks opencode and cursor to review the processes one by one", () => {
    for (const cli of ["opencode", "cursor"] as const) {
      const prompt = buildReviewPrompt({ ...input, step: "step2", cli });

      expect(prompt.split("\n")[0]).toBe(
        "Using the pseudo-code processes in docs/code-review/feat-login/ (the N.N-<process>.md files), " +
          "review the processes one by one, sequentially, in this session, " +
          "to do a code review of this branch (feat/login).",
      );
      expect(prompt).toContain("drawn with Mermaid inside the HTML");
      expect(prompt).not.toContain("parallel");
    }
  });

  it("asks every CLI for the database diagram, the full hunks and the chosen base branch", () => {
    for (const cli of ["claude", "codex", "opencode", "cursor"] as const) {
      const prompt = buildReviewPrompt({
        ...input,
        step: "step2",
        cli,
        branch: "fix/a",
        base: "origin/develop",
      });

      expect(prompt).toContain("drawn as a Mermaid erDiagram inside the HTML");
      expect(prompt).toContain('the text "No database changes" when its `Database` line is `none`');
      expect(prompt).toContain(
        "every hunk listed in its `Files`, complete, from `git diff origin/develop...HEAD`",
      );
      expect(prompt).toContain(
        "a header naming this branch (fix/a) and the base branch (origin/develop)",
      );
      expect(prompt).toContain('<meta name="base" content="origin/develop">');
    }
  });

  it("falls back to the session model when no reviewers' model is given", () => {
    const prompt = buildReviewPrompt({ ...input, step: "step2", reviewersModel: "  " });

    expect(prompt).toContain("and the same model as this session for the reviewer agents");
  });
});

describe("buildReviewPrompt both", () => {
  it("runs Step 1 and then Step 2 in one prompt", () => {
    const step1 = buildReviewPrompt(input).split("\n").slice(0, -1).join("\n");
    const step2 = CLAUDE_STEP2.split("\n").slice(0, -1).join("\n");

    expect(buildReviewPrompt({ ...input, step: "both" })).toBe(
      [
        "Do this code review in two steps, finishing Step 1 before starting Step 2.",
        "",
        "Step 1:",
        step1,
        "",
        "Step 2:",
        step2,
        "",
        "Only write those files; do not modify anything else in the repository.",
      ].join("\n"),
    );
  });
});
