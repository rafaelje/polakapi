export interface SkillEntry {
  cli: string;
  name: string;
  description: string;
  path: string;
  source: string;
}

export interface SkillExplainResult {
  text: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  sessionId?: string | null;
  error?: string | null;
}

export const EXPLAIN_CLIS = ["claude", "codex", "opencode"] as const;
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
    case "opencode":
      return "opencode-go/glm-5.2";
  }
}
