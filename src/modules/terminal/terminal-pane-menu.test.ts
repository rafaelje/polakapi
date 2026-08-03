import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/ui/modal", () => ({ promptModal: vi.fn() }));

import { openPaneMenu, openTerminalContextMenu } from "./terminal-pane-menu";

function trigger(): HTMLButtonElement {
  const button = document.createElement("button");
  document.body.append(button);
  return button;
}

describe("openPaneMenu docking actions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("exposes four keyboard-operable directional actions", () => {
    const onDockAtEdge = vi.fn();
    const menu = openPaneMenu({
      trigger: trigger(),
      getStartupCmd: () => undefined,
      onChangeStartupCmd: vi.fn(),
      canDock: () => true,
      onDockAtEdge,
    });
    const bottom = document.querySelector<HTMLButtonElement>(
      '.pane-menu-item[data-dock-position="bottom"]',
    );

    expect(document.querySelectorAll("[data-dock-position]")).toHaveLength(4);
    expect(bottom?.disabled).toBe(false);
    bottom?.click();
    expect(onDockAtEdge).toHaveBeenCalledExactlyOnceWith("bottom");
    expect(document.querySelector(".pane-menu-popover")).toBeNull();
    menu.dispose();
  });

  it("disables every docking action when only one pane exists", () => {
    const onDockAtEdge = vi.fn();
    const menu = openPaneMenu({
      trigger: trigger(),
      getStartupCmd: () => undefined,
      onChangeStartupCmd: vi.fn(),
      canDock: () => false,
      onDockAtEdge,
    });
    const items = [...document.querySelectorAll<HTMLButtonElement>("[data-dock-position]")];

    expect(items).toHaveLength(4);
    expect(items.every((item) => item.disabled)).toBe(true);
    items[0]?.click();
    expect(onDockAtEdge).not.toHaveBeenCalled();
    menu.dispose();
  });

  it("closes with Escape", () => {
    openPaneMenu({
      trigger: trigger(),
      getStartupCmd: () => undefined,
      onChangeStartupCmd: vi.fn(),
      canDock: () => true,
      onDockAtEdge: vi.fn(),
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(document.querySelector(".pane-menu-popover")).toBeNull();
  });
});

describe("openTerminalContextMenu", () => {
  afterEach(() => {
    document.querySelectorAll(".pane-menu-popover").forEach((node) => node.remove());
  });

  function items(): HTMLButtonElement[] {
    return [...document.querySelectorAll<HTMLButtonElement>(".pane-menu-item")];
  }

  it("runs actions only on an explicit item click, never on open", () => {
    const onCopy = vi.fn();
    const onPaste = vi.fn();
    openTerminalContextMenu({
      at: { x: 10, y: 20 },
      hasSelection: () => true,
      onCopy,
      onPaste,
    });

    expect(onCopy).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();

    const [copy, paste] = items();
    expect(copy?.textContent).toBe("Copy");
    expect(paste?.textContent).toBe("Paste");
    paste?.click();
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onCopy).not.toHaveBeenCalled();
    expect(document.querySelector(".pane-menu-popover")).toBeNull();
  });

  it("disables Copy when there is no selection", () => {
    const onCopy = vi.fn();
    openTerminalContextMenu({
      at: { x: 0, y: 0 },
      hasSelection: () => false,
      onCopy,
      onPaste: vi.fn(),
    });

    const [copy] = items();
    expect(copy?.disabled).toBe(true);
    copy?.click();
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("closes on outside mousedown without running any action", () => {
    const onCopy = vi.fn();
    const onPaste = vi.fn();
    openTerminalContextMenu({
      at: { x: 0, y: 0 },
      hasSelection: () => true,
      onCopy,
      onPaste,
    });

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(document.querySelector(".pane-menu-popover")).toBeNull();
    expect(onCopy).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();
  });
});
