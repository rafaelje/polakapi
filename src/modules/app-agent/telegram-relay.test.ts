import { beforeEach, describe, expect, it, vi } from "vitest";

const ptyWrite = vi.fn<(id: string, data: string) => Promise<void>>(() => Promise.resolve());
const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve(true));
vi.mock("../terminal/pty-client", () => ({
  ptyWrite: (id: string, data: string) => ptyWrite(id, data),
}));
vi.mock("../../shared/tauri/invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  findPermissionPrompt,
  forwardToTelegram,
  permissionKeys,
  respondToPermission,
  type PaneLookup,
} from "./telegram-relay";

const BASH_PROMPT = [
  "● I'll push the branch.",
  "╭──────────────────────────────────────╮",
  "│ Bash command                         │",
  "│                                      │",
  "│   git push origin main               │",
  "│                                      │",
  "│ Do you want to proceed?              │",
  "│ ❯ 1. Yes                             │",
  "│   2. Yes, and don't ask again for git push │",
  "│   3. No, and tell Claude what to do differently (esc) │",
  "╰──────────────────────────────────────╯",
].join("\n");

const TWO_OPTIONS = ["Do you want to proceed?", "❯ 1. Yes", "  2. No (esc)"].join("\n");

function lookup(screen: string | null): PaneLookup {
  return {
    findPane: (id) => (screen === null || id !== "pty-1" ? null : { readScreen: () => screen }),
  };
}

beforeEach(() => {
  ptyWrite.mockClear();
  invoke.mockClear();
});

describe("permission prompts", () => {
  it("extracts the question with its context and without the box", () => {
    const prompt = findPermissionPrompt(BASH_PROMPT)!;
    expect(prompt.startsWith("● I'll push the branch.")).toBe(true);
    expect(prompt).toContain("git push origin main");
    expect(prompt).toContain("Do you want to proceed?");
    expect(prompt).toContain("3. No, and tell Claude");
    expect(prompt).not.toContain("│");
    expect(prompt).not.toContain("╭");
  });

  it("ignores screens without a pending question", () => {
    expect(findPermissionPrompt("$ ls\nREADME.md")).toBeNull();
    expect(findPermissionPrompt("Do you want to know more? I can explain.")).toBeNull();
  });

  it("maps choices to keys and refuses 'always' when the prompt lacks it", () => {
    expect(permissionKeys(BASH_PROMPT, "allow")).toBe("1");
    expect(permissionKeys(BASH_PROMPT, "always")).toBe("2");
    expect(permissionKeys(BASH_PROMPT, "deny")).toBe("\x1b");
    expect(() => permissionKeys(TWO_OPTIONS, "always")).toThrow(/no option to stop asking/);
  });

  it("types the answer only while the prompt is on screen", async () => {
    await expect(
      respondToPermission(lookup(BASH_PROMPT), "pty-1:subagent:a", "allow"),
    ).resolves.toEqual({ answered: "allow" });
    expect(ptyWrite).toHaveBeenCalledWith("pty-1", "1");
    await expect(respondToPermission(lookup("$ "), "pty-1", "allow")).rejects.toThrow(
      /no longer waiting/,
    );
    await expect(respondToPermission(lookup(null), "pty-1", "deny")).rejects.toThrow(/gone/);
    expect(ptyWrite).toHaveBeenCalledTimes(1);
  });
});

it("reads the prompt Claude Code 2.1 draws", () => {
  const screen = [
    "● Creating empty test file",
    " Bash command",
    " Create empty test file",
    "╌".repeat(40),
    " touch polakapi-perm-test.txt",
    "╌".repeat(40),
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and always allow access to /tmp/x from this project",
    "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
    "   4. No",
    " Esc to cancel · Tab to amend",
  ].join("\n");
  const prompt = findPermissionPrompt(screen)!;
  expect(prompt).toContain("touch polakapi-perm-test.txt");
  expect(prompt).not.toContain("╌");
  expect(permissionKeys(prompt, "always")).toBe("2");
});

describe("forwarding", () => {
  it("sends the notice with the prompt for permission alerts", async () => {
    await forwardToTelegram(
      lookup(BASH_PROMPT),
      { ptyId: "pty-1", kind: "permission", cli: "claude" },
      "polakapi · claude",
      "Agent needs permission",
    );
    const [command, args] = invoke.mock.calls[0] as [string, { notice: Record<string, unknown> }];
    expect(command).toBe("telegram_notify");
    expect(args.notice.ptyId).toBe("pty-1");
    expect(String(args.notice.prompt)).toContain("git push origin main");
  });

  it("sends other alerts without reading the pane", async () => {
    await forwardToTelegram(
      lookup(null),
      { ptyId: "pty-1", kind: "finished", cli: "claude" },
      "t",
      "Agent finished",
    );
    const [, args] = invoke.mock.calls[0] as [string, { notice: Record<string, unknown> }];
    expect(args.notice.prompt).toBeNull();
  });
});
