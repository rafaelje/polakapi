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
