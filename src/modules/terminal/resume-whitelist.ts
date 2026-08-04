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

// Aliases/functions from the user's own rc files are always allowed.
export function shouldReplayShellCommand(command: string, isAlias: boolean): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (isAlias) return true;
  const first = trimmed.split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? first;
  return RESUME_COMMAND_WHITELIST.has(base.toLowerCase());
}
