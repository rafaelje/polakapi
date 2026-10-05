// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Tauri hashes inline <style> blocks into the page's CSP, and a hash in
// `style-src` makes the webview ignore 'unsafe-inline'. xterm injects its
// colors and font as <style> elements at runtime, so one inline block in an
// entry page leaves every terminal in it grey and in the wrong font.

const ROOT = resolve(__dirname, "../..");

describe("html entry pages", () => {
  it("keep styles in stylesheets, never inline", () => {
    const pages = readdirSync(ROOT).filter((file) => file.endsWith(".html"));
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const html = readFileSync(resolve(ROOT, page), "utf8");
      expect(html, page).not.toMatch(/<style[\s>]/i);
    }
  });
});
