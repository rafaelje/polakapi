import { describe, expect, it, vi } from "vitest";

import { resolveAppShortcut, wireShortcuts, type ShortcutKeyEvent } from "./shortcuts";

function ev(overrides: Partial<ShortcutKeyEvent>): ShortcutKeyEvent {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("resolveAppShortcut on Linux/Windows (Ctrl+Shift)", () => {
  const isMac = false;

  it("maps Ctrl+Shift+T/W/P to pane and palette actions", () => {
    expect(resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: "T" }), isMac)).toEqual({
      kind: "new-pane",
    });
    expect(resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: "W" }), isMac)).toEqual({
      kind: "close-focused",
    });
    expect(resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: "P" }), isMac)).toEqual({
      kind: "toggle-palette",
    });
    expect(resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: "K" }), isMac)).toBeNull();
  });

  it("maps Ctrl+Shift+M to the menu bar toggle only on Linux/Windows", () => {
    expect(resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: "M" }), isMac)).toEqual({
      kind: "toggle-menu-bar",
    });
    expect(resolveAppShortcut(ev({ ctrlKey: true, key: "m" }), isMac)).toBeNull();
    expect(resolveAppShortcut(ev({ metaKey: true, shiftKey: true, key: "M" }), true)).toBeNull();
  });

  it("maps Ctrl+Shift+brackets and digits via physical key codes", () => {
    expect(
      resolveAppShortcut(
        ev({ ctrlKey: true, shiftKey: true, key: "{", code: "BracketLeft" }),
        isMac,
      ),
    ).toEqual({ kind: "focus-prev" });
    expect(
      resolveAppShortcut(
        ev({ ctrlKey: true, shiftKey: true, key: "}", code: "BracketRight" }),
        isMac,
      ),
    ).toEqual({ kind: "focus-next" });
    expect(
      resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: "!", code: "Digit1" }), isMac),
    ).toEqual({ kind: "focus-index", index: 0 });
    expect(
      resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: "(", code: "Digit9" }), isMac),
    ).toEqual({ kind: "focus-index", index: 8 });
  });

  it("maps Ctrl+Shift+Arrow to directional focus", () => {
    expect(
      resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: "ArrowLeft" }), isMac),
    ).toEqual({ kind: "focus-direction", direction: "left" });
    expect(
      resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: "ArrowDown" }), isMac),
    ).toEqual({ kind: "focus-direction", direction: "down" });
  });

  it("leaves plain Ctrl combos to the shell (kill-word, transpose, Escape…)", () => {
    expect(resolveAppShortcut(ev({ ctrlKey: true, key: "w" }), isMac)).toBeNull();
    expect(resolveAppShortcut(ev({ ctrlKey: true, key: "t" }), isMac)).toBeNull();
    expect(
      resolveAppShortcut(ev({ ctrlKey: true, key: "[", code: "BracketLeft" }), isMac),
    ).toBeNull();
    expect(resolveAppShortcut(ev({ ctrlKey: true, key: "1", code: "Digit1" }), isMac)).toBeNull();
  });

  it("ignores combos with Alt or Meta held", () => {
    expect(
      resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, altKey: true, key: "T" }), isMac),
    ).toBeNull();
    expect(
      resolveAppShortcut(ev({ ctrlKey: true, metaKey: true, shiftKey: true, key: "T" }), isMac),
    ).toBeNull();
  });
});

describe("resolveAppShortcut on macOS (Cmd)", () => {
  const isMac = true;

  it("dispatches Cmd+Option+arrows before they reach terminal input", () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const focusDirection = vi.fn();
    const dispose = wireShortcuts({
      newPane: vi.fn(),
      splitPane: vi.fn(),
      closeFocused: vi.fn(),
      focusByIndex: vi.fn(),
      focusPrev: vi.fn(),
      focusNext: vi.fn(),
      focusDirection,
      togglePalette: vi.fn(),
      toggleMenuBar: vi.fn(),
    });
    const input = document.createElement("textarea");
    const terminalInput = vi.fn();
    input.addEventListener("keydown", terminalInput);
    document.body.append(input);
    try {
      for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
        const event = new KeyboardEvent("keydown", {
          key,
          metaKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(focusDirection.mock.calls).toEqual([["left"], ["right"], ["up"], ["down"]]);
      expect(terminalInput).not.toHaveBeenCalled();
    } finally {
      dispose();
      platform.mockRestore();
      input.remove();
    }
  });

  it.each([
    { altKey: true },
    { metaKey: true },
    { metaKey: true, altKey: true, shiftKey: true },
    { metaKey: true, altKey: true, ctrlKey: true },
    { ctrlKey: true, altKey: true },
    { ctrlKey: true, altKey: true, shiftKey: true },
  ])("leaves other arrow modifiers unbound: %j", (modifiers) => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect(resolveAppShortcut(ev({ key, ...modifiers }), isMac)).toBeNull();
      expect(resolveAppShortcut(ev({ key, ...modifiers }), false)).toBeNull();
    }
  });

  it("splits to the right with Cmd+D and below with Cmd+Shift+D", () => {
    expect(resolveAppShortcut(ev({ key: "d", metaKey: true }), true)).toEqual({
      kind: "split-pane",
      position: "right",
    });
    expect(resolveAppShortcut(ev({ key: "D", metaKey: true, shiftKey: true }), true)).toEqual({
      kind: "split-pane",
      position: "bottom",
    });
    expect(resolveAppShortcut(ev({ key: "d", ctrlKey: true }), false)).toBeNull();
    expect(resolveAppShortcut(ev({ key: "d", metaKey: true, altKey: true }), true)).toBeNull();
    expect(resolveAppShortcut(ev({ key: "d", metaKey: true, ctrlKey: true }), true)).toBeNull();
  });

  it("dispatches both splits before the keystrokes reach terminal input", () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const splitPane = vi.fn();
    const dispose = wireShortcuts({
      newPane: vi.fn(),
      splitPane,
      closeFocused: vi.fn(),
      focusByIndex: vi.fn(),
      focusPrev: vi.fn(),
      focusNext: vi.fn(),
      focusDirection: vi.fn(),
      togglePalette: vi.fn(),
      toggleMenuBar: vi.fn(),
    });
    const input = document.createElement("textarea");
    const terminalInput = vi.fn();
    input.addEventListener("keydown", terminalInput);
    document.body.append(input);
    try {
      for (const shiftKey of [false, true]) {
        const event = new KeyboardEvent("keydown", {
          key: shiftKey ? "D" : "d",
          metaKey: true,
          shiftKey,
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(splitPane.mock.calls).toEqual([["right"], ["bottom"]]);
      expect(terminalInput).not.toHaveBeenCalled();
    } finally {
      dispose();
      platform.mockRestore();
      input.remove();
    }
  });

  it("keeps the shift-less Cmd combos", () => {
    expect(resolveAppShortcut(ev({ metaKey: true, key: "t" }), isMac)).toEqual({
      kind: "new-pane",
    });
    expect(resolveAppShortcut(ev({ metaKey: true, key: "[" }), isMac)).toEqual({
      kind: "focus-prev",
    });
    expect(resolveAppShortcut(ev({ metaKey: true, key: "3" }), isMac)).toEqual({
      kind: "focus-index",
      index: 2,
    });
    expect(resolveAppShortcut(ev({ metaKey: true, key: "k" }), isMac)).toBeNull();
  });

  it("maps Cmd+Shift+Arrow to directional focus but no other shifted combos", () => {
    expect(
      resolveAppShortcut(ev({ metaKey: true, shiftKey: true, key: "ArrowUp" }), isMac),
    ).toEqual({ kind: "focus-direction", direction: "up" });
    expect(resolveAppShortcut(ev({ metaKey: true, shiftKey: true, key: "T" }), isMac)).toBeNull();
  });

  it("does not treat Ctrl as the command key", () => {
    expect(resolveAppShortcut(ev({ ctrlKey: true, key: "t" }), isMac)).toBeNull();
  });
});
