/** `global` lives under the user's home, `project` is checked into a repo. */
export type SkillScope = "global" | "project";

export interface SkillEntry {
  cli: string;
  name: string;
  description: string;
  path: string;
  source: string;
  scope: SkillScope;
  projectPath: string | null;
}

export interface SkillExplainResult {
  text: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  sessionId?: string | null;
  error?: string | null;
}

// Only CLIs with a verified read-only mode: claude `--allowedTools Read`,
// codex `sandbox_mode=read-only`, cursor `--mode ask`. opencode is excluded
// until its equivalent is confirmed — the explain path feeds the agent file
// content the user did not author.
export const EXPLAIN_CLIS = ["claude", "codex", "cursor"] as const;
export type ExplainCli = (typeof EXPLAIN_CLIS)[number];

export function isExplainCli(value: string): value is ExplainCli {
  return (EXPLAIN_CLIS as readonly string[]).includes(value);
}

export function defaultExplainModelFor(cli: ExplainCli): string {
  switch (cli) {
    case "claude":
      return "claude-opus-4-7";
    case "codex":
      return "gpt-5.5";
    case "cursor":
      // cursor-agent resolves `auto` against the user's plan, so it works
      // without assuming which models they have access to.
      return "auto";
  }
}
