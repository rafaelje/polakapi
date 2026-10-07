// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const OPENERS_DIR = resolve(ROOT, "src/modules/agents-flow");
const MAIN_CAPABILITY = resolve(ROOT, "src-tauri/capabilities/default.json");

// Tauri checks every window method against the calling window's capability.
// The /loop, /sessions, /adversarial and /context buttons run in the main
// window and bring an already-open popup back with these calls, so a method
// the main capability does not grant fails silently into the catch block and
// the popup never comes to the front.

const PERMISSION_FOR_METHOD: Record<string, string> = {
  unminimize: "core:window:allow-unminimize",
  show: "core:window:allow-show",
  setFocus: "core:window:allow-set-focus",
};

function methodsCalledOnExistingWindows(): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const name of readdirSync(OPENERS_DIR).filter((file) => file.endsWith("-window.ts"))) {
    const source = readFileSync(join(OPENERS_DIR, name), "utf8");
    const methods = [...source.matchAll(/\bexisting\.(\w+)\(/g)].map((match) => match[1]);
    if (methods.length > 0) byFile.set(name, [...new Set(methods)]);
  }
  return byFile;
}

describe("window capabilities", () => {
  it("finds the popup openers it is meant to guard", () => {
    expect(methodsCalledOnExistingWindows().size).toBeGreaterThanOrEqual(4);
  });

  it("lets the main window bring an already-open popup to the front", () => {
    const granted = new Set<string>(
      (JSON.parse(readFileSync(MAIN_CAPABILITY, "utf8")) as { permissions: string[] }).permissions,
    );
    const missing: string[] = [];
    for (const [file, methods] of methodsCalledOnExistingWindows()) {
      for (const method of methods) {
        const permission = PERMISSION_FOR_METHOD[method];
        if (!permission) {
          missing.push(`${file}: existing.${method}() has no permission mapped in this test`);
        } else if (!granted.has(permission)) {
          missing.push(`${file}: existing.${method}() needs ${permission}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("covers project windows with their own capability", () => {
    const capability = JSON.parse(
      readFileSync(resolve(ROOT, "src-tauri/capabilities/project-window.json"), "utf8"),
    ) as { windows: string[]; permissions: string[] };
    expect(capability.windows).toContain("project-*");
    for (const permission of [
      "core:default",
      "core:window:allow-destroy",
      "clipboard-manager:allow-read-text",
      "clipboard-manager:allow-write-text",
      "notification:default",
    ]) {
      expect(capability.permissions).toContain(permission);
    }
  });
});
