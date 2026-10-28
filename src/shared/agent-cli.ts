export const AGENT_CLIS = ["claude", "codex", "opencode", "cursor"] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];

export function isAgentCli(value: string): value is AgentCli {
  return (AGENT_CLIS as readonly string[]).includes(value);
}

export function defaultModelFor(cli: AgentCli): string {
  switch (cli) {
    case "claude":
      return "claude-opus-4-7";
    case "codex":
      return "gpt-5.5";
    case "opencode":
      return "opencode-go/glm-5.2";
    case "cursor":
      // cursor-agent resolves `auto` against the user's plan, so it works
      // without assuming which models they have access to.
      return "auto";
  }
}
