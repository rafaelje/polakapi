import type { ColorToken } from "../state/types";
import { PALETTE } from "../state/workspaces-reducer-appearance";

// ---------------------------------------------------------------------------
// F4 appearance picker — small popover anchored to the menu trigger that lets
// the user pick one of the 6 PALETTE colors.
//
// Mirrors the lifecycle contract of `openRowMenu`: outside click, Escape,
// scroll and resize all dispose the popover. `onPickColor` fires as the user
// makes a choice — no implicit confirm step. The popover stays open until the
// user dismisses it so the user can preview a few tints before closing.
// ---------------------------------------------------------------------------

export interface AppearancePickerOptions {
  trigger: HTMLElement;
  currentColor?: ColorToken;
  onPickColor(color: ColorToken | undefined): void;
}

export interface AppearancePickerHandle {
  dispose(): void;
}

export function openAppearancePicker(opts: AppearancePickerOptions): AppearancePickerHandle {
  const popover = document.createElement("div");
  popover.className = "appearance-picker";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Appearance");

  // --- Color chips row -----------------------------------------------------
  const colorRow = document.createElement("div");
  colorRow.className = "appearance-picker-row appearance-picker-colors";

  let activeChip: HTMLButtonElement | null = null;
  const setActiveChip = (next: HTMLButtonElement | null): void => {
    if (activeChip) activeChip.classList.remove("selected");
    activeChip = next;
    if (activeChip) activeChip.classList.add("selected");
  };

  for (const color of PALETTE) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ws-color-chip";
    chip.dataset.color = color;
    chip.title = color;
    chip.setAttribute("aria-label", `Color ${color}`);
    if (opts.currentColor === color) {
      chip.classList.add("selected");
      activeChip = chip;
    }
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      setActiveChip(chip);
      opts.onPickColor(color);
    });
    colorRow.append(chip);
  }

  const resetColorBtn = document.createElement("button");
  resetColorBtn.type = "button";
  resetColorBtn.className = "appearance-picker-reset";
  resetColorBtn.title = "Reset color to default";
  resetColorBtn.textContent = "×";
  resetColorBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setActiveChip(null);
    opts.onPickColor(undefined);
  });
  colorRow.append(resetColorBtn);

  popover.append(colorRow);

  document.body.append(popover);
  positionAt(popover, opts.trigger);

  // --- Lifecycle listeners (mirror row-menu) -------------------------------
  let disposed = false;
  const onDocMouseDown = (e: MouseEvent): void => {
    const target = e.target as Node | null;
    if (!target) return;
    if (popover.contains(target) || opts.trigger.contains(target)) return;
    handle.dispose();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      handle.dispose();
    }
  };
  const onScrollOrResize = (): void => handle.dispose();

  document.addEventListener("mousedown", onDocMouseDown, true);
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", onScrollOrResize);
  window.addEventListener("scroll", onScrollOrResize, true);

  const handle: AppearancePickerHandle = {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("mousedown", onDocMouseDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
      popover.remove();
    },
  };

  return handle;
}

function positionAt(popover: HTMLElement, trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  popover.style.position = "fixed";
  popover.style.left = "0px";
  popover.style.top = "0px";
  const popRect = popover.getBoundingClientRect();
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;

  let left = rect.right - popRect.width;
  if (left < 8) left = Math.min(rect.left, viewportW - popRect.width - 8);
  let top = rect.bottom + 4;
  if (top + popRect.height > viewportH - 8) {
    top = Math.max(8, rect.top - popRect.height - 4);
  }
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}
