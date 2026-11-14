import { afterEach, describe, expect, it, vi } from "vitest";
import { openTerminalContextMenu } from "./terminal-pane-menu";

describe("terminal copy menu", () => {
  afterEach(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.body.replaceChildren();
  });

  it("exposes command/output actions and keeps Copy/Paste, then restores terminal focus", () => {
    const onCopyCommand = vi.fn();
    const onClose = vi.fn();
    openTerminalContextMenu({
      at: { x: 10, y: 20 },
      hasSelection: () => true,
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onClose,
      commandActions: { command: "pwd", output: "/tmp\n", onCopyCommand, onCopyOutput: vi.fn() },
    });
    const items = [...document.querySelectorAll<HTMLButtonElement>("button")];
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Copy",
      "Copy command",
      "Copy output",
      "Paste",
    ]);
    items[1].click();
    expect(onCopyCommand).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.querySelector(".pane-menu-popover")).toBeNull();
  });

  it("disables unavailable data and supports keyboard navigation", () => {
    openTerminalContextMenu({
      at: { x: 0, y: 0 },
      hasSelection: () => false,
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      commandActions: { command: "", output: null, onCopyCommand: vi.fn(), onCopyOutput: vi.fn() },
    });
    const items = [...document.querySelectorAll<HTMLButtonElement>("button")];
    expect(items.map((item) => item.disabled)).toEqual([true, true, true, false]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
    expect(document.activeElement).toBe(items[3]);
  });
});
