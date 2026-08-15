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
  const commandPath = singleCommandPath(trimmed);
  if (commandPath === null) return false;
  const base = commandPath.split(/[\\/]/).pop() ?? commandPath;
  const normalized = base.replace(/\.(?:exe|cmd|bat|com)$/i, "").toLowerCase();
  return RESUME_COMMAND_WHITELIST.has(normalized);
}

function singleCommandPath(command: string): string | null {
  const quote = command[0];
  if (quote === '"' || quote === "'") {
    if (command[command.length - 1] !== quote) return null;
    const inner = command.slice(1, -1);
    return inner.length > 0 && !inner.includes(quote) ? inner : null;
  }
  return /\s/.test(command) ? null : command;
}
