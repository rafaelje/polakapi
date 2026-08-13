import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachTerminalKeybindings, resolveTerminalKeyInput } from "./terminal-keybindings";

function stubPlatform(value: string): void {
  Object.defineProperty(navigator, "platform", { value, configurable: true });
}

describe("resolveTerminalKeyInput", () => {
  it("maps Command+Left to beginning of line on mac", () => {
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true });

    expect(resolveTerminalKeyInput(event, true)).toBe("\x01");
  });

  it("maps Command+Right to end of line on mac", () => {
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true });

    expect(resolveTerminalKeyInput(event, true)).toBe("\x05");
  });

  it("maps Shift+Enter to a line break on mac", () => {
    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true });

    expect(resolveTerminalKeyInput(event, true)).toBe("\n");
  });

  it("maps Shift+Enter to a line break on non-mac", () => {
    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true });

    expect(resolveTerminalKeyInput(event, false)).toBe("\n");
  });

  it("does not map arrow shortcuts on non-mac", () => {
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true });

    expect(resolveTerminalKeyInput(event, false)).toBeNull();
  });

  it.each([
    new KeyboardEvent("keydown", { key: "ArrowLeft" }),
    new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true, shiftKey: true }),
    new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true, altKey: true }),
    new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true, ctrlKey: true }),
    new KeyboardEvent("keydown", { key: "Enter", metaKey: true, shiftKey: true }),
    new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true }),
    new KeyboardEvent("keydown", { key: "Enter", altKey: true, shiftKey: true }),
    new KeyboardEvent("keydown", { key: "Enter", metaKey: true }),
    new KeyboardEvent("keydown", { key: "a", metaKey: true }),
  ])("ignores unrelated key combinations", (event) => {
    expect(resolveTerminalKeyInput(event, true)).toBeNull();
  });
});

describe("attachTerminalKeybindings", () => {
  const originalPlatform = navigator.platform;

  beforeEach(() => {
    stubPlatform("MacIntel");
  });

  afterEach(() => {
    stubPlatform(originalPlatform);
  });

  it("writes a line break on Shift+Enter and prevents the webview shortcut", () => {
    const element = document.createElement("div");
    const target = document.createElement("textarea");
    element.appendChild(target);
    const write = vi.fn();
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    const handle = attachTerminalKeybindings({ element }, write);
    target.dispatchEvent(event);

    expect(write).toHaveBeenCalledWith("\n");
    expect(event.defaultPrevented).toBe(true);
    handle.dispose();
  });

  it("maps Shift+Enter regardless of platform", () => {
    stubPlatform("Linux x86_64");
    const element = document.createElement("div");
    const write = vi.fn();

    const handle = attachTerminalKeybindings({ element }, write);
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(write).toHaveBeenCalledWith("\n");
    handle.dispose();
  });

  it("removes the listener when disposed", () => {
    const element = document.createElement("div");
    const write = vi.fn();
    const handle = attachTerminalKeybindings({ element }, write);
    handle.dispose();

    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(write).not.toHaveBeenCalled();
  });
});
