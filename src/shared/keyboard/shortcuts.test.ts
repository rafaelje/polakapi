import { describe, expect, it } from "vitest";

import { resolveAppShortcut, type ShortcutKeyEvent } from "./shortcuts";

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

  it("maps Ctrl+Shift+T/W/P/K to pane and palette actions", () => {
    expect(resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: "T" }), isMac)).toEqual({
      kind: "new-pane",
    });
    expect(resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: "W" }), isMac)).toEqual({
      kind: "close-focused",
    });
    expect(resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: "P" }), isMac)).toEqual({
      kind: "toggle-palette",
    });
    expect(resolveAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: "K" }), isMac)).toEqual({
      kind: "toggle-command-center",
    });
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
    expect(resolveAppShortcut(ev({ metaKey: true, key: "k" }), isMac)).toEqual({
      kind: "toggle-command-center",
    });
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
