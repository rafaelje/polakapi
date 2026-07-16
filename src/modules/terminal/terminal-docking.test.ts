import { afterEach, describe, expect, it, vi } from "vitest";

import { attachTerminalDocking, resolveTerminalDockPosition } from "./terminal-docking";

function pointerEvent(type: string, init: MouseEventInit): Event {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
}

function setup(): {
  grid: HTMLElement;
  source: HTMLElement;
  sourceHeader: HTMLElement;
  target: HTMLElement;
} {
  const grid = document.createElement("div");
  const source = document.createElement("div");
  source.className = "pane";
  source.dataset.ptyId = "source";
  const sourceHeader = document.createElement("div");
  sourceHeader.className = "pane-header";
  source.append(sourceHeader);
  const target = document.createElement("div");
  target.className = "pane";
  target.dataset.ptyId = "target";
  grid.append(source, target);
  document.body.append(grid);
  Object.defineProperty(target, "getBoundingClientRect", {
    value: () => ({ top: 100, right: 500, bottom: 500, left: 100, width: 400, height: 400 }),
  });
  Object.defineProperty(document, "elementFromPoint", {
    value: () => target,
    configurable: true,
  });
  return { grid, source, sourceHeader, target };
}

describe("resolveTerminalDockPosition", () => {
  const rect = { top: 100, right: 500, bottom: 500, left: 100, width: 400, height: 400 };

  it("selects the nearest directional edge", () => {
    expect(resolveTerminalDockPosition(rect, 300, 110)).toBe("top");
    expect(resolveTerminalDockPosition(rect, 490, 300)).toBe("right");
    expect(resolveTerminalDockPosition(rect, 300, 490)).toBe("bottom");
    expect(resolveTerminalDockPosition(rect, 110, 300)).toBe("left");
  });

  it("returns null outside the target", () => {
    expect(resolveTerminalDockPosition(rect, 20, 20)).toBeNull();
  });
});

describe("attachTerminalDocking", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows four zones and commits a valid directional drop", () => {
    const { grid, sourceHeader } = setup();
    const onDock = vi.fn();
    const handle = attachTerminalDocking({
      handle: sourceHeader,
      grid,
      paneId: "source",
      onDock,
    });

    sourceHeader.dispatchEvent(
      pointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10 }),
    );
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 300, clientY: 490 }));

    expect(document.querySelectorAll(".terminal-dock-zone")).toHaveLength(4);
    expect(document.querySelector(".terminal-dock-zone--bottom.is-active")).not.toBeNull();
    expect(document.querySelector(".terminal-dock-preview--bottom")).not.toBeNull();

    window.dispatchEvent(pointerEvent("pointerup", { clientX: 300, clientY: 490 }));

    expect(onDock).toHaveBeenCalledExactlyOnceWith("source", "target", "bottom");
    expect(document.querySelector(".terminal-dock-overlay")).toBeNull();
    handle.dispose();
  });

  it("does not start until the drag threshold is crossed", () => {
    const { grid, sourceHeader } = setup();
    const onDock = vi.fn();
    const handle = attachTerminalDocking({
      handle: sourceHeader,
      grid,
      paneId: "source",
      onDock,
    });

    sourceHeader.dispatchEvent(
      pointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10 }),
    );
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 12, clientY: 12 }));
    window.dispatchEvent(pointerEvent("pointerup", { clientX: 12, clientY: 12 }));

    expect(onDock).not.toHaveBeenCalled();
    expect(document.querySelector(".terminal-dock-overlay")).toBeNull();
    handle.dispose();
  });

  it("cancels an active drag with Escape", () => {
    const { grid, sourceHeader } = setup();
    const onDock = vi.fn();
    const handle = attachTerminalDocking({
      handle: sourceHeader,
      grid,
      paneId: "source",
      onDock,
    });

    sourceHeader.dispatchEvent(
      pointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10 }),
    );
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 110, clientY: 300 }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.dispatchEvent(pointerEvent("pointerup", { clientX: 110, clientY: 300 }));

    expect(onDock).not.toHaveBeenCalled();
    expect(document.querySelector(".terminal-dock-overlay")).toBeNull();
    handle.dispose();
  });

  it("ignores pointer starts from interactive header controls", () => {
    const { grid, sourceHeader } = setup();
    const button = document.createElement("button");
    sourceHeader.append(button);
    const onDock = vi.fn();
    const handle = attachTerminalDocking({
      handle: sourceHeader,
      grid,
      paneId: "source",
      onDock,
    });

    button.dispatchEvent(pointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 490, clientY: 300 }));
    window.dispatchEvent(pointerEvent("pointerup", { clientX: 490, clientY: 300 }));

    expect(onDock).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("does not drop onto the source pane or outside the grid", () => {
    const { grid, source, sourceHeader } = setup();
    Object.defineProperty(document, "elementFromPoint", {
      value: () => source,
      configurable: true,
    });
    const onDock = vi.fn();
    const handle = attachTerminalDocking({
      handle: sourceHeader,
      grid,
      paneId: "source",
      onDock,
    });

    sourceHeader.dispatchEvent(
      pointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10 }),
    );
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 100, clientY: 100 }));
    window.dispatchEvent(pointerEvent("pointerup", { clientX: 100, clientY: 100 }));

    expect(onDock).not.toHaveBeenCalled();
    handle.dispose();
  });
});
