import { describe, expect, it } from "vitest";

import {
  agentSpawnSpec,
  changeAgentSelection,
  initialAgentSelection,
  shouldRestartAgent,
} from "./agent-session";

describe("agent selection", () => {
  it("starts on claude with the CLI's own default model", () => {
    expect(initialAgentSelection()).toEqual({ cli: "claude", model: "" });
  });

  it("resets the model to the new CLI's own default when the CLI changes", () => {
    const current = { cli: "claude", model: "claude-sonnet-4-6" } as const;
    expect(changeAgentSelection(current, { cli: "codex" })).toEqual({ cli: "codex", model: "" });
  });

  it("keeps the model when the same CLI is picked again", () => {
    const current = { cli: "claude", model: "claude-sonnet-4-6" } as const;
    expect(changeAgentSelection(current, { cli: "claude" })).toBe(current);
  });

  it("ignores CLIs outside the shared list", () => {
    const current = { cli: "claude", model: "claude-opus-4-7" } as const;
    expect(changeAgentSelection(current, { cli: "shell" })).toBe(current);
  });

  it("takes the trimmed model the user typed", () => {
    const current = { cli: "opencode", model: "opencode-go/glm-5.2" } as const;
    expect(changeAgentSelection(current, { model: " anthropic/claude-sonnet-4-6 " })).toEqual({
      cli: "opencode",
      model: "anthropic/claude-sonnet-4-6",
    });
  });

  it("returns the same selection when the typed model does not change it", () => {
    const current = { cli: "codex", model: "gpt-5.5" } as const;
    expect(changeAgentSelection(current, { model: "gpt-5.5 " })).toBe(current);
  });
});

describe("agent restart decision", () => {
  const running = { cli: "claude", model: "claude-opus-4-7" } as const;

  it("starts a terminal when none is running", () => {
    expect(shouldRestartAgent(null, running)).toBe(true);
  });

  it("keeps the running terminal when the selection is the same", () => {
    expect(shouldRestartAgent(running, { ...running })).toBe(false);
  });

  it("restarts when the CLI or the model changes", () => {
    expect(shouldRestartAgent(running, { cli: "codex", model: "claude-opus-4-7" })).toBe(true);
    expect(shouldRestartAgent(running, { cli: "claude", model: "claude-sonnet-4-6" })).toBe(true);
  });
});

describe("agent spawn spec", () => {
  it("launches the chosen CLI with its model in the project root", () => {
    expect(agentSpawnSpec({ cli: "claude", model: "claude-opus-4-7" }, "/repo")).toEqual({
      cliId: "claude",
      command: "claude",
      args: ["--model", "claude-opus-4-7"],
      cwd: "/repo",
    });
  });

  it("runs cursor through the cursor-agent binary", () => {
    const spec = agentSpawnSpec({ cli: "cursor", model: "auto" }, "/repo");
    expect(spec.command).toBe("cursor-agent");
    expect(spec.args).toEqual(["--model", "auto"]);
  });

  it("trims the model and leaves the CLI default when it is blank", () => {
    expect(agentSpawnSpec({ cli: "codex", model: "  gpt-5.5 " }, "/repo").args).toEqual([
      "--model",
      "gpt-5.5",
    ]);
    expect(agentSpawnSpec({ cli: "opencode", model: "   " }, "/repo").args).toEqual([]);
  });
});
