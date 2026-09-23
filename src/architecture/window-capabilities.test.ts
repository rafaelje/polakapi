import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Popup openers call window setters on an already-open window to bring it to
// the front. Those setters are not in `core:default`; without the matching
// permission the call rejects and the popup silently fails to reappear.

const ROOT = resolve(__dirname, "../..");
const OPENERS_DIR = resolve(ROOT, "src/modules/agents-flow");
const CAPABILITY = resolve(ROOT, "src-tauri/capabilities/default.json");

const PERMISSION_FOR_METHOD: Record<string, string> = {
  unminimize: "core:window:allow-unminimize",
  show: "core:window:allow-show",
  setFocus: "core:window:allow-set-focus",
};

function methodsCalledOnExistingWindows(): Set<string> {
  const methods = new Set<string>();
  for (const file of readdirSync(OPENERS_DIR)) {
    if (!file.endsWith("-window.ts")) continue;
    const source = readFileSync(resolve(OPENERS_DIR, file), "utf8");
    for (const match of source.matchAll(/existing\.(\w+)\(/g)) methods.add(match[1]);
  }
  return methods;
}

describe("window capabilities", () => {
  it("grants every window setter the popup openers rely on", () => {
    const methods = methodsCalledOnExistingWindows();
    expect(methods.size).toBeGreaterThanOrEqual(3);
    const granted = (JSON.parse(readFileSync(CAPABILITY, "utf8")) as { permissions: string[] })
      .permissions;
    for (const method of methods) {
      const permission = PERMISSION_FOR_METHOD[method];
      expect(permission, `unknown window method ${method}`).toBeDefined();
      expect(granted, `${method}() needs ${permission}`).toContain(permission);
    }
  });

  it("covers project windows with their own capability", () => {
    const capability = JSON.parse(
      readFileSync(resolve(ROOT, "src-tauri/capabilities/project-window.json"), "utf8"),
    ) as { windows: string[]; permissions: string[] };
    expect(capability.windows).toContain("project-*");
    for (const permission of [
      "core:default",
      "clipboard-manager:allow-read-text",
      "clipboard-manager:allow-write-text",
      "notification:default",
    ]) {
      expect(capability.permissions).toContain(permission);
    }
  });
});
