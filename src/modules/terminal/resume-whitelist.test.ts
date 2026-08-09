import { describe, expect, it } from "vitest";

import { shouldReplayShellCommand } from "./resume-whitelist";

describe("shouldReplayShellCommand", () => {
  it("allows whitelisted programs without arguments", () => {
    expect(shouldReplayShellCommand("lazygit", false)).toBe(true);
    expect(shouldReplayShellCommand("nvim", false)).toBe(true);
    expect(shouldReplayShellCommand("python", false)).toBe(true);
  });

  it("rejects one-shot mutating commands like git push", () => {
    expect(shouldReplayShellCommand("git push origin main", false)).toBe(false);
    expect(shouldReplayShellCommand("git commit -m x", false)).toBe(false);
    expect(shouldReplayShellCommand("docker system prune -af", false)).toBe(false);
    expect(shouldReplayShellCommand("rm -rf build", false)).toBe(false);
  });

  it("rejects arguments and aliases that can hide mutating behavior", () => {
    expect(shouldReplayShellCommand("npm run deploy:prod", false)).toBe(false);
    expect(shouldReplayShellCommand("node scripts/drop-database.js", false)).toBe(false);
    expect(shouldReplayShellCommand("php artisan migrate:fresh", false)).toBe(false);
    expect(shouldReplayShellCommand("ssh production", false)).toBe(false);
    expect(shouldReplayShellCommand("gpush", true)).toBe(false);
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
