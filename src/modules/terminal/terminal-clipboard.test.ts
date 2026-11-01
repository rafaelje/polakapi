import { beforeEach, describe, expect, it, vi } from "vitest";

const clipboardPlugin = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => clipboardPlugin);

import {
  attachTerminalClipboard,
  attachTerminalContextMenuGuard,
  attachTerminalCopyPasteKeys,
  normalizeTerminalSelection,
  resolveCopyPasteKey,
  resolveCommandCopyKey,
  type CommandCopyActions,
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

describe("command copy shortcuts", () => {
  it("does not treat an AltGr-generated character on KeyC as a copy shortcut", () => {
    expect(
      resolveCommandCopyKey(
        new KeyboardEvent("keydown", {
          key: "ć",
          code: "KeyC",
          ctrlKey: true,
          altKey: true,
          modifierAltGraph: true,
        }),
        false,
      ),
    ).toBeNull();
  });

  it("preserves an explicit Ctrl+Alt+C even when the platform reports AltGraph", () => {
    expect(
      resolveCommandCopyKey(
        new KeyboardEvent("keydown", {
          key: "c",
          code: "KeyC",
          ctrlKey: true,
          altKey: true,
          modifierAltGraph: true,
        }),
        false,
      ),
    ).toBe("command");
  });
  it("matches the macOS command/output shortcuts, including the Option-modified key", () => {
    expect(
      resolveCommandCopyKey(
        new KeyboardEvent("keydown", {
          key: "C",
          metaKey: true,
          shiftKey: true,
        }),
        true,
      ),
    ).toBe("command");
    expect(
      resolveCommandCopyKey(
        new KeyboardEvent("keydown", {
          key: "Ç",
          code: "KeyC",
          metaKey: true,
          shiftKey: true,
          altKey: true,
        }),
        true,
      ),
    ).toBe("output");
  });

  it("keeps Ctrl+C and Ctrl+Shift+C free and uses Ctrl+Alt for command/output on other platforms", () => {
    expect(
      resolveCommandCopyKey(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }), false),
    ).toBeNull();
    expect(
      resolveCommandCopyKey(
        new KeyboardEvent("keydown", { key: "C", ctrlKey: true, shiftKey: true }),
        false,
      ),
    ).toBeNull();
    expect(
      resolveCommandCopyKey(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true, altKey: true }),
        false,
      ),
    ).toBe("command");
    expect(
      resolveCommandCopyKey(
        new KeyboardEvent("keydown", { key: "C", ctrlKey: true, altKey: true, shiftKey: true }),
        false,
      ),
    ).toBe("output");
  });
});

describe("attachTerminalCopyPasteKeys", () => {
  beforeEach(() => {
    clipboardPlugin.readText.mockReset();
    clipboardPlugin.writeText.mockReset();
    clipboardPlugin.writeText.mockResolvedValue(undefined);
  });

  function makeTerm(
    selection: string,
    commands?: CommandCopyActions,
  ): {
    handler: (event: KeyboardEvent) => boolean;
    paste: ReturnType<typeof vi.fn>;
  } {
    let handler!: (event: KeyboardEvent) => boolean;
    const paste = vi.fn();
    attachTerminalCopyPasteKeys(
      {
        attachCustomKeyEventHandler: (h) => {
          handler = h;
        },
        getSelection: () => selection,
        paste,
      },
      commands,
    );
    return { handler, paste };
  }

  it.each([false, true])("runs only the requested block-copy callback (output: %s)", (shiftKey) => {
    const commands = { onCopyCommand: vi.fn(), onCopyOutput: vi.fn() };
    const { handler } = makeTerm("selection", commands);
    const event = new KeyboardEvent("keydown", {
      key: "c",
      code: "KeyC",
      ctrlKey: true,
      altKey: true,
      shiftKey,
      cancelable: true,
    });
    expect(handler(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(commands.onCopyCommand).toHaveBeenCalledTimes(shiftKey ? 0 : 1);
    expect(commands.onCopyOutput).toHaveBeenCalledTimes(shiftKey ? 1 : 0);
    expect(clipboardPlugin.writeText).not.toHaveBeenCalled();
  });

  it.each([
    ["ć", false],
    ["c", false],
    ["Ć", true],
    ["C", true],
  ] as const)(
    "lets AltGr+C input through and restores shortcuts after release (%s, shift: %s)",
    (key, shiftKey) => {
      const commands = { onCopyCommand: vi.fn(), onCopyOutput: vi.fn() };
      const { handler } = makeTerm("", commands);
      handler(
        new KeyboardEvent("keydown", {
          key: "AltGraph",
          code: "AltRight",
          ctrlKey: true,
          altKey: true,
        }),
      );
      const event = new KeyboardEvent("keydown", {
        key,
        code: "KeyC",
        ctrlKey: true,
        altKey: true,
        modifierAltGraph: true,
        shiftKey,
        cancelable: true,
      });
      expect(handler(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
      expect(commands.onCopyCommand).not.toHaveBeenCalled();
      expect(commands.onCopyOutput).not.toHaveBeenCalled();
      handler(new KeyboardEvent("keyup", { key: "AltGraph", code: "AltRight" }));
      expect(handler(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, altKey: true }))).toBe(
        false,
      );
      expect(commands.onCopyCommand).toHaveBeenCalledOnce();
      handler(
        new KeyboardEvent("keydown", {
          key: "AltGraph",
          code: "AltRight",
          ctrlKey: true,
          altKey: true,
        }),
      );
      handler(
        new KeyboardEvent("keydown", { key: "Alt", code: "AltLeft", ctrlKey: true, altKey: true }),
      );
      expect(
        handler(
          new KeyboardEvent("keydown", {
            key: "C",
            code: "KeyC",
            ctrlKey: true,
            altKey: true,
            shiftKey: true,
            modifierAltGraph: true,
          }),
        ),
      ).toBe(false);
      expect(commands.onCopyOutput).toHaveBeenCalledOnce();
    },
  );

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

describe("attachTerminalContextMenuGuard", () => {
  it("blocks the native menu, stops xterm's handler, and reports cursor coords", () => {
    const body = document.createElement("div");
    const xtermRoot = document.createElement("div");
    body.appendChild(xtermRoot);
    const xtermHandler = vi.fn();
    xtermRoot.addEventListener("contextmenu", xtermHandler);
    const onOpen = vi.fn();

    const handle = attachTerminalContextMenuGuard(body, onOpen);
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 60,
    });
    xtermRoot.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(xtermHandler).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith({ x: 40, y: 60 });

    handle.dispose();
    const after = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    xtermRoot.dispatchEvent(after);
    expect(xtermHandler).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
