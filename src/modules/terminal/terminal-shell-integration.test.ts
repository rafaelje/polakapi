import { describe, expect, it } from "vitest";

import { parseShellCommandPayload } from "./terminal-shell-integration";

function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe("parseShellCommandPayload", () => {
  it("parses flagged payloads with alias detection", () => {
    expect(parseShellCommandPayload(`c;${b64("git push")}`)).toEqual({
      command: "git push",
      isAlias: false,
    });
    expect(parseShellCommandPayload(`a;${b64("gpush")}`)).toEqual({
      command: "gpush",
      isAlias: true,
    });
  });

  it("treats unflagged payloads from older scripts as non-alias", () => {
    expect(parseShellCommandPayload(b64("npm run dev"))).toEqual({
      command: "npm run dev",
      isAlias: false,
    });
  });

  it("decodes UTF-8 command text", () => {
    expect(parseShellCommandPayload(`c;${b64("echo ñandú 中文")}`)).toEqual({
      command: "echo ñandú 中文",
      isAlias: false,
    });
  });

  it("returns null for malformed or empty payloads", () => {
    expect(parseShellCommandPayload("not-base64!!!")).toBeNull();
    expect(parseShellCommandPayload(`c;${b64("   ")}`)).toBeNull();
    expect(parseShellCommandPayload("")).toBeNull();
  });
});
