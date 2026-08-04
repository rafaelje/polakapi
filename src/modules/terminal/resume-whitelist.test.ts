import { describe, expect, it } from "vitest";

import { shouldReplayShellCommand } from "./resume-whitelist";

describe("shouldReplayShellCommand", () => {
  it("allows session-like whitelisted programs", () => {
    expect(shouldReplayShellCommand("lazygit", false)).toBe(true);
    expect(shouldReplayShellCommand("npm run dev", false)).toBe(true);
    expect(shouldReplayShellCommand("php artisan serve", false)).toBe(true);
    expect(shouldReplayShellCommand("tail -f /var/log/syslog", false)).toBe(true);
    expect(shouldReplayShellCommand("claude --continue", false)).toBe(true);
  });

  it("rejects one-shot mutating commands like git push", () => {
    expect(shouldReplayShellCommand("git push origin main", false)).toBe(false);
    expect(shouldReplayShellCommand("git commit -m x", false)).toBe(false);
    expect(shouldReplayShellCommand("docker system prune -af", false)).toBe(false);
    expect(shouldReplayShellCommand("rm -rf build", false)).toBe(false);
  });

  it("always allows alias/function commands from the user's rc files", () => {
    expect(shouldReplayShellCommand("gpush", true)).toBe(true);
    expect(shouldReplayShellCommand("dev", true)).toBe(true);
  });

  it("matches by basename and case-insensitively", () => {
    expect(shouldReplayShellCommand("/usr/bin/htop", false)).toBe(true);
    expect(shouldReplayShellCommand("HTOP", false)).toBe(true);
    expect(shouldReplayShellCommand("/usr/bin/git status", false)).toBe(false);
  });

  it("rejects empty input", () => {
    expect(shouldReplayShellCommand("", false)).toBe(false);
    expect(shouldReplayShellCommand("   ", true)).toBe(false);
  });
});
