export interface CliProfile {
  id: string;
  label: string;
  command: string;
  args?: string[];
  kind: "shell" | "ai-cli";
  /**
   * Extra args that make the CLI resume its previous session instead of
   * starting fresh — used when un-suspending a pane. Absent = plain respawn.
   */
  resumeArgs?: string[];
}

export const SHELL_PROFILE: CliProfile = {
  id: "shell",
  label: "Shell",
  command: "",
  kind: "shell",
};

export const AI_CLI_PROFILES: CliProfile[] = [
  { id: "claude", label: "Claude", command: "claude", kind: "ai-cli", resumeArgs: ["--continue"] },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    kind: "ai-cli",
    resumeArgs: ["resume", "--last"],
  },
  {
    id: "opencode",
    label: "Opencode",
    command: "opencode",
    kind: "ai-cli",
    resumeArgs: ["--continue"],
  },
  {
    id: "cursor",
    label: "Cursor",
    command: "cursor-agent",
    kind: "ai-cli",
    resumeArgs: ["resume"],
  },
];

export const ALL_PROFILES: CliProfile[] = [SHELL_PROFILE, ...AI_CLI_PROFILES];

export function resolveProfile(cliId?: string): CliProfile {
  if (!cliId) return SHELL_PROFILE;
  return ALL_PROFILES.find((p) => p.id === cliId) ?? SHELL_PROFILE;
}
