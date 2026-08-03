import { beforeEach, describe, expect, it, vi } from "vitest";

const clipboardPlugin = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => clipboardPlugin);

import {
  attachTerminalClipboard,
  attachTerminalCopyPasteKeys,
  normalizeTerminalSelection,
  resolveCopyPasteKey,
} from "./terminal-clipboard";

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

describe("resolveCopyPasteKey", () => {
  const keydown = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent("keydown", init);

  it("maps Ctrl+Shift+C to copy and Ctrl+Shift+V to paste", () => {
    expect(resolveCopyPasteKey(keydown({ key: "C", ctrlKey: true, shiftKey: true }))).toBe("copy");
    expect(resolveCopyPasteKey(keydown({ key: "V", ctrlKey: true, shiftKey: true }))).toBe("paste");
  });

  it("ignores plain Ctrl+C (SIGINT must still reach the shell)", () => {
    expect(resolveCopyPasteKey(keydown({ key: "c", ctrlKey: true }))).toBeNull();
    expect(resolveCopyPasteKey(keydown({ key: "v", ctrlKey: true }))).toBeNull();
  });

  it("ignores other modifiers, keys, and non-keydown events", () => {
    expect(
      resolveCopyPasteKey(keydown({ key: "C", ctrlKey: true, shiftKey: true, altKey: true })),
    ).toBeNull();
    expect(resolveCopyPasteKey(keydown({ key: "X", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(
      resolveCopyPasteKey(new KeyboardEvent("keyup", { key: "C", ctrlKey: true, shiftKey: true })),
    ).toBeNull();
  });
});

describe("attachTerminalCopyPasteKeys", () => {
  beforeEach(() => {
    clipboardPlugin.readText.mockReset();
    clipboardPlugin.writeText.mockReset();
    clipboardPlugin.writeText.mockResolvedValue(undefined);
  });

  function makeTerm(selection: string): {
    handler: (event: KeyboardEvent) => boolean;
    paste: ReturnType<typeof vi.fn>;
  } {
    let handler!: (event: KeyboardEvent) => boolean;
    const paste = vi.fn();
    attachTerminalCopyPasteKeys({
      attachCustomKeyEventHandler: (h) => {
        handler = h;
      },
      getSelection: () => selection,
      paste,
    });
    return { handler, paste };
  }

  it("copies the selection through the Tauri clipboard and stops xterm handling", () => {
    const { handler } = makeTerm("hello");

    const event = new KeyboardEvent("keydown", {
      key: "C",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    const result = handler(event);

    expect(result).toBe(false);
    expect(clipboardPlugin.writeText).toHaveBeenCalledWith("hello");
  });

  it("does not touch the clipboard when there is no selection", () => {
    const { handler } = makeTerm("");
    handler(
      new KeyboardEvent("keydown", { key: "C", ctrlKey: true, shiftKey: true, cancelable: true }),
    );
    expect(clipboardPlugin.writeText).not.toHaveBeenCalled();
  });

  it("pastes clipboard text through term.paste", async () => {
    clipboardPlugin.readText.mockResolvedValue("pasted");
    const { handler, paste } = makeTerm("");

    const result = handler(
      new KeyboardEvent("keydown", { key: "V", ctrlKey: true, shiftKey: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(result).toBe(false);
    expect(paste).toHaveBeenCalledWith("pasted");
  });

  it("lets unrelated keys through to xterm", () => {
    const { handler } = makeTerm("hello");
    const result = handler(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }));
    expect(result).toBe(true);
  });
});
