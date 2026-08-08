export interface ProjectCommand {
  id: string;
  label: string;
  group: string;
  keywords?: readonly string[];
  disabled?: boolean;
  run(this: void): void;
}

export interface ProjectCommandCenterOptions {
  trigger: HTMLButtonElement;
  commands: readonly ProjectCommand[];
}

export interface ProjectCommandCenterHandle {
  dispose(returnFocus?: boolean): void;
}

export function openProjectCommandCenter(
  opts: ProjectCommandCenterOptions,
): ProjectCommandCenterHandle {
  document.querySelectorAll(".project-command-center").forEach((node) => node.remove());

  const popover = document.createElement("div");
  popover.className = "project-command-center";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "project-command-center-input";
  input.placeholder = "Type a project command…";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", "Search project commands");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "true");

  const list = document.createElement("div");
  list.className = "project-command-center-list";
  list.id = `project-command-list-${crypto.randomUUID()}`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Project commands");
  input.setAttribute("aria-controls", list.id);

  popover.append(input, list);
  document.body.append(popover);
  positionCommandCenter(popover, opts.trigger);
  opts.trigger.setAttribute("aria-controls", list.id);
  opts.trigger.setAttribute("aria-expanded", "true");

  let filtered = [...opts.commands];
  let selectedIndex = 0;
  let disposed = false;

  const enabledIndexes = (): number[] =>
    filtered.flatMap((command, index) => (command.disabled ? [] : [index]));

  const selectFirstEnabled = (): void => {
    selectedIndex = enabledIndexes()[0] ?? -1;
  };

  const render = (): void => {
    list.replaceChildren();
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "project-command-center-empty";
      empty.textContent = "No matching commands";
      list.append(empty);
      input.removeAttribute("aria-activedescendant");
      return;
    }

    filtered.forEach((command, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.id = `project-command-${command.id}`;
      item.className = "project-command-center-item";
      item.disabled = command.disabled === true;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === selectedIndex));
      item.dataset.commandId = command.id;

      const label = document.createElement("span");
      label.className = "project-command-center-item-label";
      label.textContent = command.label;

      const group = document.createElement("span");
      group.className = "project-command-center-item-group";
      group.textContent = command.group;

      item.append(label, group);
      item.addEventListener("mouseenter", () => {
        if (item.disabled) return;
        selectedIndex = index;
        updateSelection();
      });
      item.addEventListener("click", () => execute(command));
      list.append(item);
    });
    updateSelection();
  };

  const updateSelection = (): void => {
    list.querySelectorAll<HTMLElement>("[role=option]").forEach((item, index) => {
      item.setAttribute("aria-selected", String(index === selectedIndex));
    });
    const selected = list.querySelector<HTMLElement>(
      `[data-command-id="${filtered[selectedIndex]?.id ?? ""}"]`,
    );
    if (selected) {
      input.setAttribute("aria-activedescendant", selected.id);
      selected.scrollIntoView?.({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const execute = (command: ProjectCommand | undefined): void => {
    if (!command || command.disabled) return;
    handle.dispose();
    command.run();
  };

  const moveSelection = (direction: 1 | -1): void => {
    const enabled = enabledIndexes();
    if (enabled.length === 0) return;
    const current = enabled.indexOf(selectedIndex);
    const next = current < 0 ? 0 : (current + direction + enabled.length) % enabled.length;
    selectedIndex = enabled[next] ?? enabled[0] ?? -1;
    updateSelection();
  };

  const onInput = (): void => {
    const query = input.value.trim().toLocaleLowerCase();
    filtered = opts.commands.filter((command) => {
      const haystack = [command.label, command.group, ...(command.keywords ?? [])]
        .join(" ")
        .toLocaleLowerCase();
      return query.length === 0 || haystack.includes(query);
    });
    selectFirstEnabled();
    render();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      handle.dispose(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      execute(filtered[selectedIndex]);
    }
  };

  const onOutside = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (target && (popover.contains(target) || opts.trigger.contains(target))) return;
    handle.dispose();
  };
  const onViewportChange = (): void => handle.dispose();

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKey);
  document.addEventListener("mousedown", onOutside, true);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);

  const handle: ProjectCommandCenterHandle = {
    dispose(returnFocus = false): void {
      if (disposed) return;
      disposed = true;
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      opts.trigger.removeAttribute("aria-controls");
      opts.trigger.setAttribute("aria-expanded", "false");
      popover.remove();
      if (returnFocus) opts.trigger.focus();
    },
  };

  selectFirstEnabled();
  render();
  requestAnimationFrame(() => input.focus());
  return handle;
}

function positionCommandCenter(popover: HTMLElement, trigger: HTMLElement): void {
  popover.style.position = "fixed";
  popover.style.left = "0px";
  popover.style.top = "0px";

  const popoverRect = popover.getBoundingClientRect();
  const triggerRect = trigger.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - popoverRect.width - 8);
  const left = Math.min(Math.max(8, triggerRect.left), maxLeft);
  const below = triggerRect.bottom + 6;
  const top =
    below + popoverRect.height <= window.innerHeight - 8
      ? below
      : Math.max(8, triggerRect.top - popoverRect.height - 6);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}
