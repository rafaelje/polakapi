import { describe, expect, it } from "vitest";

import { normalizePath, pathStartsWith, pathsEqual } from "./path-comparison";

describe("path comparison", () => {
  it("normalizes separators and trailing slashes", () => {
    expect(normalizePath("C:\\Users\\Dev\\Polakapi\\")).toBe("C:/Users/Dev/Polakapi");
    expect(normalizePath("/")).toBe("/");
  });

  it("compares Windows paths case-insensitively", () => {
    expect(pathsEqual("C:\\Users\\Dev\\Polakapi", "c:/users/dev/polakapi/")).toBe(true);
    expect(pathsEqual("\\\\Server\\Share\\Repo", "//server/share/repo")).toBe(true);
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(pathsEqual("/Users/Dev/Polakapi", "/Users/dev/polakapi")).toBe(false);
  });

  it("matches Windows descendants without matching sibling prefixes", () => {
    expect(pathStartsWith("C:/DEV/Polakapi/src", "c:/dev/polakapi")).toBe(true);
    expect(pathStartsWith("C:/dev/polakapi-other", "C:/dev/polakapi")).toBe(false);
  });

  it("matches descendants of the POSIX root", () => {
    expect(pathStartsWith("/workspace/project", "/")).toBe(true);
  });
});
