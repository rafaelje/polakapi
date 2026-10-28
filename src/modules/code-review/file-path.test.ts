import { describe, expect, it } from "vitest";
import { splitPath } from "./file-path";

describe("splitPath", () => {
  it("splits a nested path into its directory and file name", () => {
    expect(splitPath("src/app/main.ts")).toEqual({ dir: "src/app/", name: "main.ts" });
  });

  it("has no directory for a top-level file", () => {
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});
