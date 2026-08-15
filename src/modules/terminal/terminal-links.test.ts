import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/tauri/invoke", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { invoke } from "../../shared/tauri/invoke";
import { classifyLinkText, findAbsolutePaths, openLinkFromText } from "./terminal-links";

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
    expect(classifyLinkText("file:///C:/Users/dev/a%20b.txt")).toEqual({
      kind: "path",
      path: "C:/Users/dev/a b.txt",
    });
    expect(classifyLinkText("file://localhost/C:/Users/dev/a%20b.txt")).toEqual({
      kind: "path",
      path: "C:/Users/dev/a b.txt",
    });
  });

  it("rejects remote file uris, UNC paths, and Windows device namespaces", () => {
    expect(classifyLinkText("file://server/share/report.txt")).toBeNull();
    expect(classifyLinkText("file:////server/share/report.txt")).toBeNull();
    expect(classifyLinkText(String.raw`\\server\share\report.txt`)).toBeNull();
    expect(classifyLinkText("//server/share/report.txt")).toBeNull();
    expect(classifyLinkText(String.raw`/\server\share\report.txt`)).toBeNull();
    expect(classifyLinkText(String.raw`\/server/share/report.txt`)).toBeNull();
    expect(classifyLinkText("file:///%5Cserver/share/report.txt")).toBeNull();
    expect(classifyLinkText(String.raw`\\.\PhysicalDrive0`)).toBeNull();
    expect(classifyLinkText(String.raw`\\?\C:\Windows\System32`)).toBeNull();
  });

  it("rejects malformed encoded file uris", () => {
    expect(classifyLinkText("file:///tmp/%")).toBeNull();
  });

  it("classifies absolute and ~ paths, stripping :line:col suffixes", () => {
    expect(classifyLinkText("/home/user/src/main.ts:12:5")).toEqual({
      kind: "path",
      path: "/home/user/src/main.ts",
    });
    expect(classifyLinkText("~/repo/file.rs")).toEqual({ kind: "path", path: "~/repo/file.rs" });
  });

  it("classifies Windows drive and home-relative paths", () => {
    expect(classifyLinkText(String.raw`C:\Users\dev\src\main.ts:12:5`)).toEqual({
      kind: "path",
      path: String.raw`C:\Users\dev\src\main.ts`,
    });
    expect(classifyLinkText("D:/work/polakapi/src/main.ts:9")).toEqual({
      kind: "path",
      path: "D:/work/polakapi/src/main.ts",
    });
    expect(classifyLinkText(String.raw`~\repo\file.rs`)).toEqual({
      kind: "path",
      path: String.raw`~\repo\file.rs`,
    });
  });

  it("rejects anything else (schemes, relative paths, prose)", () => {
    expect(classifyLinkText("javascript:alert(1)")).toBeNull();
    expect(classifyLinkText("ftp://host/file")).toBeNull();
    expect(classifyLinkText("src/main.ts")).toBeNull();
    expect(classifyLinkText("C:relative\\file.ts")).toBeNull();
    expect(classifyLinkText("hola mundo")).toBeNull();
  });
});

describe("openLinkFromText", () => {
  it("reports activation failures without an unhandled rejection", async () => {
    const error = new Error("open failed");
    vi.mocked(invoke).mockRejectedValueOnce(error);
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);

    openLinkFromText("https://example.com");
    await Promise.resolve();
    await Promise.resolve();

    expect(report).toHaveBeenCalledWith("Failed to open terminal link", error);
    report.mockRestore();
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

  it("finds Windows drive paths with compiler positions and correct offsets", () => {
    const line = String.raw`error at C:\Users\dev\app\src\main.ts:14:3, fix it`;
    const [match] = findAbsolutePaths(line);
    expect(match?.text).toBe(String.raw`C:\Users\dev\app\src\main.ts:14:3`);
    expect(line.slice(match.start, match.start + match.text.length)).toBe(match.text);
  });

  it("finds forward-slash Windows paths but rejects UNC and device paths", () => {
    const line = String.raw`compare "\\server\share\a.txt" with (D:/tmp/out.log)`;
    expect(findAbsolutePaths(line).map((match) => match.text)).toEqual(["D:/tmp/out.log"]);
    expect(findAbsolutePaths(String.raw`open \\.\PhysicalDrive0 or \\?\C:\Windows`)).toEqual([]);
  });

  it("rejects remote file URI links", () => {
    expect(findAbsolutePaths("open file://server/share/report.txt")).toEqual([]);
    expect(findAbsolutePaths("open file:////server/share/report.txt")).toEqual([]);
  });

  it("finds an unquoted Windows path with spaces when it has a compiler position", () => {
    const line = String.raw` --> C:\Users\Jane Doe\repo\src\main.rs:12:3`;
    const [match] = findAbsolutePaths(line);
    expect(match?.text).toBe(String.raw`C:\Users\Jane Doe\repo\src\main.rs:12:3`);
    expect(line.slice(match.start, match.start + match.text.length)).toBe(match.text);
  });

  it("finds a quoted Windows path containing spaces", () => {
    const line = String.raw`open "C:\Program Files\polakapi\report.txt:12:3" now`;
    const [match] = findAbsolutePaths(line);
    expect(match?.text).toBe(String.raw`C:\Program Files\polakapi\report.txt:12:3`);
    expect(line.slice(match.start, match.start + match.text.length)).toBe(match.text);
  });

  it("preserves closing delimiters inside quoted Windows paths", () => {
    const line = String.raw`open "C:\Program Files (x86)" now`;
    const [match] = findAbsolutePaths(line);
    expect(match?.text).toBe(String.raw`C:\Program Files (x86)`);
    expect(classifyLinkText(match.text)).toEqual({
      kind: "path",
      path: String.raw`C:\Program Files (x86)`,
    });

    const [bracketMatch] = findAbsolutePaths(String.raw`open "C:\SDK[preview]" now`);
    expect(classifyLinkText(bracketMatch.text)).toEqual({
      kind: "path",
      path: String.raw`C:\SDK[preview]`,
    });
  });

  it("matches multiple file:// URIs on separate lines and trims trailing punctuation", () => {
    const line = "see file:///home/user/a.md and file:///home/user/b.txt.";
    expect(findAbsolutePaths(line).map((m) => m.text)).toEqual([
      "file:///home/user/a.md",
      "file:///home/user/b.txt",
    ]);
  });
});
