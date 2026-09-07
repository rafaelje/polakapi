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

  it("maps Command+Backspace to Ctrl+U on mac", () => {
    const event = new KeyboardEvent("keydown", { key: "Backspace", metaKey: true });

    expect(resolveTerminalKeyInput(event, true)).toBe("\x15");
  });

  it("maps Ctrl+Backspace to Ctrl+U on non-mac platforms", () => {
    const event = new KeyboardEvent("keydown", { key: "Backspace", ctrlKey: true });

    expect(resolveTerminalKeyInput(event, false)).toBe("\x15");
    expect(resolveTerminalKeyInput(event, true)).toBeNull();
  });

  it.each([
    { key: "Backspace" },
    { key: "Backspace", ctrlKey: true, shiftKey: true },
    { key: "Backspace", ctrlKey: true, altKey: true },
    { key: "Backspace", metaKey: true, shiftKey: true },
    { key: "Backspace", metaKey: true, altKey: true },
    { key: "Backspace", metaKey: true, ctrlKey: true },
    { key: "Delete", metaKey: true },
    { key: "Delete", ctrlKey: true },
  ])("preserves other deletion shortcuts: %j", (init) => {
    const event = new KeyboardEvent("keydown", init);

    expect(resolveTerminalKeyInput(event, true)).toBeNull();
    expect(resolveTerminalKeyInput(event, false)).toBeNull();
  });

  it("does not map Command+Backspace on non-mac platforms", () => {
    const event = new KeyboardEvent("keydown", { key: "Backspace", metaKey: true });

    expect(resolveTerminalKeyInput(event, false)).toBeNull();
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

  it.each([
    { platform: "MacIntel", metaKey: true, ctrlKey: false },
    { platform: "Win32", metaKey: false, ctrlKey: true },
    { platform: "Linux x86_64", metaKey: false, ctrlKey: true },
  ])(
    "sends Ctrl+U once and stops deletion before terminal input on $platform",
    ({ platform, metaKey, ctrlKey }) => {
      stubPlatform(platform);
      const element = document.createElement("div");
      const target = document.createElement("textarea");
      element.appendChild(target);
      const write = vi.fn();
      const terminalInput = vi.fn();
      target.addEventListener("keydown", terminalInput);
      const event = new KeyboardEvent("keydown", {
        key: "Backspace",
        metaKey,
        ctrlKey,
        bubbles: true,
        cancelable: true,
      });

      const handle = attachTerminalKeybindings({ element }, write);
      target.dispatchEvent(event);

      expect(write).toHaveBeenCalledExactlyOnceWith("\x15");
      expect(event.defaultPrevented).toBe(true);
      expect(terminalInput).not.toHaveBeenCalled();
      handle.dispose();

      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Backspace", metaKey, ctrlKey, bubbles: true }),
      );

      expect(write).toHaveBeenCalledTimes(1);
      expect(terminalInput).toHaveBeenCalledTimes(1);
    },
  );

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
