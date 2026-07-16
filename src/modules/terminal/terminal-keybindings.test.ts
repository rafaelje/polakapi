import { describe, expect, it, vi } from "vitest";

import { attachTerminalKeybindings, resolveTerminalKeyInput } from "./terminal-keybindings";

describe("resolveTerminalKeyInput", () => {
  it("maps Command+Left to beginning of line", () => {
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true });

    expect(resolveTerminalKeyInput(event)).toBe("\x01");
  });

  it("maps Command+Right to end of line", () => {
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true });

    expect(resolveTerminalKeyInput(event)).toBe("\x05");
  });

  it.each([
    new KeyboardEvent("keydown", { key: "ArrowLeft" }),
    new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true, shiftKey: true }),
    new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true, altKey: true }),
    new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true, ctrlKey: true }),
    new KeyboardEvent("keydown", { key: "a", metaKey: true }),
  ])("ignores unrelated key combinations", (event) => {
    expect(resolveTerminalKeyInput(event)).toBeNull();
  });
});

describe("attachTerminalKeybindings", () => {
  it("writes mapped input and prevents the webview shortcut", () => {
    const element = document.createElement("div");
    const target = document.createElement("textarea");
    element.appendChild(target);
    const write = vi.fn();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    const handle = attachTerminalKeybindings({ element }, write);
    target.dispatchEvent(event);

    expect(write).toHaveBeenCalledWith("\x01");
    expect(event.defaultPrevented).toBe(true);
    handle.dispose();
  });

  it("removes the listener when disposed", () => {
    const element = document.createElement("div");
    const write = vi.fn();
    const handle = attachTerminalKeybindings({ element }, write);
    handle.dispose();

    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(write).not.toHaveBeenCalled();
  });
});
