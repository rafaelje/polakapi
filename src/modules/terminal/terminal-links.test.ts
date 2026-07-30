import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/tauri/invoke", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { classifyLinkText, findAbsolutePaths } from "./terminal-links";

describe("classifyLinkText", () => {
  it("classifies http(s) URLs and strips trailing prose punctuation", () => {
    expect(classifyLinkText("https://example.com/a?b=c")).toEqual({
      kind: "url",
      url: "https://example.com/a?b=c",
    });
    expect(classifyLinkText("http://localhost:5173).")).toEqual({
      kind: "url",
      url: "http://localhost:5173",
    });
  });

  it("converts file:// uris to paths", () => {
    expect(classifyLinkText("file:///home/user/a%20b.txt")).toEqual({
      kind: "path",
      path: "/home/user/a b.txt",
    });
    expect(classifyLinkText("file://localhost/etc/hosts")).toEqual({
      kind: "path",
      path: "/etc/hosts",
    });
  });

  it("classifies absolute and ~ paths, stripping :line:col suffixes", () => {
    expect(classifyLinkText("/home/user/src/main.ts:12:5")).toEqual({
      kind: "path",
      path: "/home/user/src/main.ts",
    });
    expect(classifyLinkText("~/repo/file.rs")).toEqual({ kind: "path", path: "~/repo/file.rs" });
  });

  it("rejects anything else (schemes, relative paths, prose)", () => {
    expect(classifyLinkText("javascript:alert(1)")).toBeNull();
    expect(classifyLinkText("ftp://host/file")).toBeNull();
    expect(classifyLinkText("src/main.ts")).toBeNull();
    expect(classifyLinkText("hola mundo")).toBeNull();
  });
});

describe("findAbsolutePaths", () => {
  it("finds a path in the middle of prose with correct offset", () => {
    const line = "error at /home/user/app/src/main.ts:14:3, fix it";
    const [match] = findAbsolutePaths(line);
    expect(match?.text).toBe("/home/user/app/src/main.ts:14:3");
    expect(line.slice(match.start, match.start + match.text.length)).toBe(match.text);
  });

  it("finds multiple paths and quoted/parenthesised ones", () => {
    const line = `compare "/etc/hosts" with (/tmp/out.log)`;
    expect(findAbsolutePaths(line).map((m) => m.text)).toEqual(["/etc/hosts", "/tmp/out.log"]);
  });

  it("does not match the path portion of a URL", () => {
    expect(findAbsolutePaths("see https://example.com/a/b for details")).toEqual([]);
  });

  it("ignores lone slashes and word-internal slashes", () => {
    expect(findAbsolutePaths("either y/o esto / aquello")).toEqual([]);
  });

  it("matches ~ home-relative paths and trims trailing punctuation", () => {
    const [match] = findAbsolutePaths("open ~/projects/app, please");
    expect(match?.text).toBe("~/projects/app");
  });

  it("matches file:// URIs, which WebLinksAddon does not detect on its own", () => {
    const line = "file:///home/user/docs/report.html";
    const [match] = findAbsolutePaths(line);
    expect(match?.text).toBe(line);
    expect(line.slice(match.start, match.start + match.text.length)).toBe(match.text);
  });

  it("matches multiple file:// URIs on separate lines and trims trailing punctuation", () => {
    const line = "see file:///home/user/a.md and file:///home/user/b.txt.";
    expect(findAbsolutePaths(line).map((m) => m.text)).toEqual([
      "file:///home/user/a.md",
      "file:///home/user/b.txt",
    ]);
  });
});
