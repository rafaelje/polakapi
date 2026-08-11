// Session-like programs that are safe and useful to relaunch when a suspended
// shell resumes. Deliberately excludes one-shot mutating tools (git, docker,
// rm, ...). AI CLIs resume through their own profile resumeArgs, not here.
export const RESUME_COMMAND_WHITELIST: ReadonlySet<string> = new Set([
  "lazygit",
  "tig",
  "gitui",
  "htop",
  "btop",
  "top",
  "atop",
  "k9s",
  "watch",
  "tail",
  "ssh",
  "mosh",
  "vim",
  "nvim",
  "vi",
  "nano",
  "emacs",
  "hx",
  "micro",
  "less",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "node",
  "deno",
  "php",
  "python",
  "python3",
  "ipython",
  "irb",
  "rails",
  "claude",
  "codex",
  "opencode",
  "cursor-agent",
]);

export function shouldReplayShellCommand(command: string, isAlias: boolean): boolean {
  const trimmed = command.trim();
  if (!trimmed || isAlias) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 1) return false;
  const first = tokens[0] ?? "";
  const base = first.split("/").pop() ?? first;
  return RESUME_COMMAND_WHITELIST.has(base.toLowerCase());
}
