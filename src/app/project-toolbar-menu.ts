export interface ProjectToolbarMenuItem {
  id?: string;
  label: string;
  onSelect(this: void): void;
  disabled?: boolean;
  separatorBefore?: boolean;
  profileId?: string;
  checked?: boolean;
}

export interface ProjectToolbarMenuOptions {
  trigger: HTMLButtonElement;
  label: string;
  align?: "start" | "end";
  items: readonly ProjectToolbarMenuItem[];
}

export interface ProjectToolbarMenuHandle {
  dispose(returnFocus?: boolean): void;
}

export function openProjectToolbarMenu(opts: ProjectToolbarMenuOptions): ProjectToolbarMenuHandle {
  document.querySelectorAll(".pane-menu-popover").forEach((node) => node.remove());

  const menu = document.createElement("div");
  menu.className = "pane-menu-popover project-toolbar-popover";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", opts.label);

  const buttons: HTMLButtonElement[] = [];
  for (const item of opts.items) {
    if (item.separatorBefore) {
      const separator = document.createElement("div");
      separator.className = "pane-menu-separator";
      separator.setAttribute("role", "separator");
      menu.append(separator);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "pane-menu-item project-toolbar-menu-item";
    button.textContent = item.label;
    button.disabled = item.disabled === true;
    if (item.id) button.id = item.id;
    if (item.profileId) {
      button.dataset.cliId = item.profileId;
      button.classList.add(`project-toolbar-profile--${item.profileId}`);
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", String(item.checked === true));
      button.classList.toggle("is-active", item.checked === true);
    } else {
      button.setAttribute("role", "menuitem");
    }
    button.addEventListener("click", () => {
      if (button.disabled) return;
      handle.dispose();
      item.onSelect();
    });
    buttons.push(button);
    menu.append(button);
  }

  document.body.append(menu);
  positionMenu(menu, opts.trigger, opts.align ?? "end");
  opts.trigger.setAttribute("aria-expanded", "true");

  let disposed = false;
  const onOutside = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (target && (menu.contains(target) || opts.trigger.contains(target))) return;
    handle.dispose();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      handle.dispose(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const enabled = buttons.filter((button) => !button.disabled);
    if (enabled.length === 0) return;
    event.preventDefault();
    const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (event.key === "End") next = enabled.length - 1;
    else if (event.key === "ArrowDown") next = (current + 1) % enabled.length;
    else if (event.key === "ArrowUp") next = (current - 1 + enabled.length) % enabled.length;
    enabled[next]?.focus();
  };
  const onViewportChange = (): void => handle.dispose();

  document.addEventListener("mousedown", onOutside, true);
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);

  const handle: ProjectToolbarMenuHandle = {
    dispose(returnFocus = false): void {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      opts.trigger.setAttribute("aria-expanded", "false");
      menu.remove();
      if (returnFocus) opts.trigger.focus();
    },
  };

  requestAnimationFrame(() => {
    const selected = buttons.find((button) => button.getAttribute("aria-checked") === "true");
    (selected ?? buttons.find((button) => !button.disabled))?.focus();
  });

  return handle;
}

function positionMenu(menu: HTMLElement, trigger: HTMLElement, align: "start" | "end"): void {
  menu.style.position = "fixed";
  menu.style.left = "0px";
  menu.style.top = "0px";

  const menuRect = menu.getBoundingClientRect();
  const triggerRect = trigger.getBoundingClientRect();
  const preferredLeft = align === "start" ? triggerRect.left : triggerRect.right - menuRect.width;
  const maxLeft = Math.max(8, window.innerWidth - menuRect.width - 8);
  const left = Math.min(Math.max(8, preferredLeft), maxLeft);
  const below = triggerRect.bottom + 4;
  const top =
    below + menuRect.height <= window.innerHeight - 8
      ? below
      : Math.max(8, triggerRect.top - menuRect.height - 4);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}
