import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SOURCE_ROOTS = [resolve(ROOT, "src"), resolve(ROOT, "src-tauri/src")];

function sourceFiles(): string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      if (statSync(child).isDirectory()) visit(child);
      else files.push(child);
    }
  };
  for (const root of SOURCE_ROOTS) visit(root);
  return files;
}

function lineCount(path: string): number {
  return readFileSync(path, "utf8").split(/\r?\n/).length;
}

describe("source architecture", () => {
  it("keeps TypeScript and Rust modules within the line budget", () => {
    const violations = sourceFiles()
      .filter((path) => [".ts", ".rs"].includes(extname(path)))
      .map((path) => ({ path: relative(ROOT, path), lines: lineCount(path) }))
      .filter(({ lines }) => lines > 650);

    expect(violations).toEqual([]);
  });

  it("keeps stylesheets within the line budget", () => {
    const violations = sourceFiles()
      .filter((path) => extname(path) === ".css")
      .map((path) => ({ path: relative(ROOT, path), lines: lineCount(path) }))
      .filter(({ lines }) => lines > 1000);

    expect(violations).toEqual([]);
  });

  it("resolves every local stylesheet import", () => {
    const missing = sourceFiles()
      .filter((path) => extname(path) === ".css")
      .flatMap((path) => {
        const imports = [...readFileSync(path, "utf8").matchAll(/@import\s+["'](\.[^"']+)["']/g)];
        return imports
          .map((match) => resolve(dirname(path), match[1]))
          .filter((importedPath) => !existsSync(importedPath))
          .map((importedPath) => relative(ROOT, importedPath));
      });

    expect(missing).toEqual([]);
  });
});
