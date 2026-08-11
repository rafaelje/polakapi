export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface RowMenuOptions {
  trigger: HTMLElement;
  items: RowMenuItem[];
  /** Anchor the menu at these viewport coords (context menu) instead of `trigger`. */
  at?: { x: number; y: number };
}

export interface RowMenuHandle {
  dispose(): void;
}

/**
 * Renders a popover menu anchored to `trigger` and closes on outside-click,
 * Escape, scroll, resize or selection. Owns its own listeners and removes
 * them in `dispose()` so there are no leaks per open/close cycle.
 */
export function openRowMenu(opts: RowMenuOptions): RowMenuHandle {
  const menu = document.createElement("div");
  menu.className = "ws-row-menu";
  menu.setAttribute("role", "menu");

  for (const item of opts.items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ws-row-menu-item${item.danger ? " danger" : ""}`;
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    btn.setAttribute("role", "menuitem");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.disabled) return;
      handle.dispose();
      item.onSelect();
    });
    menu.append(btn);
  }

  document.body.append(menu);
  positionAt(menu, opts.trigger, opts.at);

  const onDocMouseDown = (e: MouseEvent): void => {
    const target = e.target as Node | null;
    if (target && (menu.contains(target) || opts.trigger.contains(target))) return;
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
  // Scroll events bubble inconsistently; listen on the capture phase to catch
  // anything in the ancestor chain.
  window.addEventListener("scroll", onScrollOrResize, true);

  let disposed = false;
  const handle: RowMenuHandle = {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("mousedown", onDocMouseDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
      menu.remove();
    },
  };

  return handle;
}

function positionAt(menu: HTMLElement, trigger: HTMLElement, at?: { x: number; y: number }): void {
  // Initial off-screen layout pass so we get real menu dimensions.
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.style.position = "fixed";
  const menuRect = menu.getBoundingClientRect();
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;

  let left: number;
  let top: number;
  if (at) {
    left = Math.min(at.x, viewportW - menuRect.width - 8);
    top = Math.min(at.y, viewportH - menuRect.height - 8);
  } else {
    const rect = trigger.getBoundingClientRect();
    left = rect.right - menuRect.width;
    if (left < 8) left = Math.min(rect.left, viewportW - menuRect.width - 8);
    top = rect.bottom + 4;
    if (top + menuRect.height > viewportH - 8) {
      top = Math.max(8, rect.top - menuRect.height - 4);
    }
  }
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}
