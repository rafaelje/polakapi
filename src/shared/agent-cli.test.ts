import { describe, expect, it } from "vitest";

import { AGENT_CLIS, defaultModelFor, isAgentCli } from "./agent-cli";

describe("agent CLIs", () => {
  it("lists every CLI polakapi can drive", () => {
    expect(AGENT_CLIS).toEqual(["claude", "codex", "opencode", "cursor"]);
  });

  it("gives each CLI its default model", () => {
    expect(defaultModelFor("claude")).toBe("claude-opus-4-7");
    expect(defaultModelFor("codex")).toBe("gpt-5.5");
    expect(defaultModelFor("opencode")).toBe("opencode-go/glm-5.2");
    expect(defaultModelFor("cursor")).toBe("auto");
  });

  it("recognizes known CLI ids and rejects anything else", () => {
    expect(isAgentCli("cursor")).toBe(true);
    expect(isAgentCli("shell")).toBe(false);
    expect(isAgentCli("")).toBe(false);
  });
});
