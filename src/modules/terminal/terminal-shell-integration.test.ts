import { describe, expect, it } from "vitest";

import { parseShellCommandPayload } from "./terminal-shell-integration";

function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe("parseShellCommandPayload", () => {
  const token = "pty-token";

  it("parses flagged payloads with alias detection", () => {
    expect(parseShellCommandPayload(`${token};c;${b64("git push")}`, token)).toEqual({
      command: "git push",
      isAlias: false,
    });
    expect(parseShellCommandPayload(`${token};a;${b64("gpush")}`, token)).toEqual({
      command: "gpush",
      isAlias: true,
    });
  });

  it("rejects payloads without the current pane token", () => {
    expect(parseShellCommandPayload(`other-token;c;${b64("lazygit")}`, token)).toBeNull();
    expect(parseShellCommandPayload(`c;${b64("lazygit")}`, token)).toBeNull();
  });

  it("decodes UTF-8 command text", () => {
    expect(parseShellCommandPayload(`${token};c;${b64("echo ñandú 中文")}`, token)).toEqual({
      command: "echo ñandú 中文",
      isAlias: false,
    });
  });

  it("returns null for malformed or empty payloads", () => {
    expect(parseShellCommandPayload(`${token};c;not-base64!!!`, token)).toBeNull();
    expect(parseShellCommandPayload(`${token};c;${b64("   ")}`, token)).toBeNull();
    expect(parseShellCommandPayload("", token)).toBeNull();
  });
});
