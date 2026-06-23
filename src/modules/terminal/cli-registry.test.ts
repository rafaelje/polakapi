import { describe, expect, it } from "vitest";

import { AI_CLI_PROFILES, ALL_PROFILES, SHELL_PROFILE, resolveProfile } from "./cli-registry";

describe("resolveProfile", () => {
  it("returns SHELL_PROFILE when cliId is undefined", () => {
    expect(resolveProfile(undefined)).toBe(SHELL_PROFILE);
  });

  it("returns SHELL_PROFILE for unknown id", () => {
    expect(resolveProfile("does-not-exist")).toBe(SHELL_PROFILE);
  });

  it("returns SHELL_PROFILE for 'shell'", () => {
    expect(resolveProfile("shell")).toBe(SHELL_PROFILE);
  });

  it("returns the matching profile for each known ai-cli id", () => {
    for (const profile of AI_CLI_PROFILES) {
      expect(resolveProfile(profile.id)).toBe(profile);
    }
  });
});

describe("ALL_PROFILES", () => {
  it("starts with the shell profile", () => {
    expect(ALL_PROFILES[0]).toBe(SHELL_PROFILE);
  });

  it("contains shell followed by all ai-cli profiles in registry order", () => {
    expect(ALL_PROFILES).toEqual([SHELL_PROFILE, ...AI_CLI_PROFILES]);
  });
});

describe("SHELL_PROFILE", () => {
  it("has an empty command so Rust resolves $SHELL", () => {
    expect(SHELL_PROFILE.command).toBe("");
  });

  it("is of kind 'shell'", () => {
    expect(SHELL_PROFILE.kind).toBe("shell");
  });
});
