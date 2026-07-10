import { describe, expect, it } from "vitest";

import { mergeScope, toRelativePath } from "./view";

describe("toRelativePath", () => {
  it("returns a repo-relative path when the absolute lives under the project", () => {
    expect(
      toRelativePath("/Users/x/Herd/polakapi", "/Users/x/Herd/polakapi/app/Services/Payment"),
    ).toBe("app/Services/Payment");
  });

  it("returns an empty string when the picker returns the project root", () => {
    expect(toRelativePath("/Users/x/Herd/polakapi", "/Users/x/Herd/polakapi")).toBe("");
  });

  it("returns null when the absolute lives outside the project", () => {
    expect(toRelativePath("/Users/x/Herd/polakapi", "/etc/passwd")).toBeNull();
    expect(toRelativePath("/Users/x/Herd/polakapi", "/Users/x/Herd/other")).toBeNull();
  });

  it("normalizes Windows-style backslashes", () => {
    expect(toRelativePath("C:\\dev\\proj", "C:\\dev\\proj\\src\\foo")).toBe("src/foo");
  });

  it("tolerates trailing slashes on the project path", () => {
    expect(toRelativePath("/x/y/", "/x/y/app")).toBe("app");
  });

  it("matches when the picker returns the macOS /System/Volumes/Data path", () => {
    expect(
      toRelativePath(
        "/Users/rafaelje/Herd/polakapi",
        "/System/Volumes/Data/Users/rafaelje/Herd/polakapi/docs",
      ),
    ).toBe("docs");
  });

  it("matches when the project path is stored with the Data prefix", () => {
    expect(
      toRelativePath(
        "/System/Volumes/Data/Users/rafaelje/Herd/polakapi",
        "/Users/rafaelje/Herd/polakapi/docs",
      ),
    ).toBe("docs");
  });

  it("returns empty when the picker returns the project root via the Data path", () => {
    expect(
      toRelativePath(
        "/Users/rafaelje/Herd/polakapi",
        "/System/Volumes/Data/Users/rafaelje/Herd/polakapi",
      ),
    ).toBe("");
  });
});

describe("mergeScope", () => {
  it("appends new paths preserving existing order", () => {
    expect(mergeScope("app/Http", ["resources/js"])).toBe("app/Http, resources/js");
  });

  it("dedupes case-sensitively", () => {
    expect(mergeScope("app/Http", ["app/Http", "app/http"])).toBe("app/Http, app/http");
  });

  it("skips leading commas when the existing input is empty", () => {
    expect(mergeScope("", ["a", "b"])).toBe("a, b");
  });

  it("handles whitespace-only existing input as empty", () => {
    expect(mergeScope("   ", ["a"])).toBe("a");
  });
});
