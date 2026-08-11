import { describe, expect, it, vi } from "vitest";

import { attachTerminalClipboard, normalizeTerminalSelection } from "./terminal-clipboard";

describe("normalizeTerminalSelection", () => {
  it("composes accented characters without changing other Unicode text", () => {
    const decomposed = "Cafe\u0301, i\u0301, o\u0301, u\u0301, nin\u0303o, 中文, 😀";
    expect(normalizeTerminalSelection(decomposed)).toBe("Café, í, ó, ú, niño, 中文, 😀");
  });

  it("preserves line endings", () => {
    expect(normalizeTerminalSelection("á\r\né\n")).toBe("á\r\né\n");
  });
});

describe("attachTerminalClipboard", () => {
  it("writes the normalized terminal selection to text/plain", () => {
    const element = document.createElement("div");
    const target = document.createElement("textarea");
    element.appendChild(target);
    const setData = vi.fn();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData } });

    const handle = attachTerminalClipboard({
      element,
      getSelection: () => "acio\u0301n",
    });
    target.dispatchEvent(event);

    expect(setData).toHaveBeenCalledWith("text/plain", "ación");
    expect(event.defaultPrevented).toBe(true);
    handle.dispose();
  });

  it("leaves native copy behavior untouched without a terminal selection", () => {
    const element = document.createElement("div");
    const setData = vi.fn();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData } });

    attachTerminalClipboard({ element, getSelection: () => "" });
    element.dispatchEvent(event);

    expect(setData).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
