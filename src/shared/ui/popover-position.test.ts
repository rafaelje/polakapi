import { afterEach, describe, expect, it } from "vitest";

import { clampPopoverToViewport } from "./popover-position";

function mountPopover(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): HTMLElement {
  const popover = document.createElement("div");
  popover.style.position = "fixed";
  popover.style.left = `${rect.left}px`;
  popover.style.top = `${rect.top}px`;
  popover.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  document.body.append(popover);
  return popover;
}

describe("clampPopoverToViewport", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps a popover that already fits in place", () => {
    const popover = mountPopover({ left: 100, top: 50, width: 200, height: 100 });
    clampPopoverToViewport(popover);
    expect(popover.style.left).toBe("100px");
    expect(popover.style.top).toBe("50px");
  });

  it("pulls a popover overflowing the right edge back into view", () => {
    const popover = mountPopover({
      left: window.innerWidth - 40,
      top: 50,
      width: 200,
      height: 100,
    });
    clampPopoverToViewport(popover);
    expect(popover.style.left).toBe(`${window.innerWidth - 200 - 8}px`);
  });

  it("pulls a popover overflowing the bottom edge back into view", () => {
    const popover = mountPopover({
      left: 100,
      top: window.innerHeight - 20,
      width: 200,
      height: 100,
    });
    clampPopoverToViewport(popover);
    expect(popover.style.top).toBe(`${window.innerHeight - 100 - 8}px`);
  });

  it("never places a popover past the viewport margin", () => {
    const popover = mountPopover({ left: -30, top: -30, width: 200, height: 100 });
    clampPopoverToViewport(popover);
    expect(popover.style.left).toBe("8px");
    expect(popover.style.top).toBe("8px");
  });
});
