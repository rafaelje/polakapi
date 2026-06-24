import {
  renderPaletteList,
  updatePaletteSelection,
  type PaletteItem,
} from "./command-palette-list";
import { deriveFallbackColor } from "../state/workspaces-reducer-appearance";
import type { ColorToken, WorkspacesState } from "../state/types";
import type { WorkspacesController } from "../state/workspaces-controller";

// ---------------------------------------------------------------------------
// F4 — Command Palette (CMD-P / Ctrl-P).
//
// Global modal that lists every project across every workspace, filterable by
// substring case-insensitive match over `${workspace.name} ${project.name}`.
// Activating a row calls `controller.setActiveProject(id)` and closes the
// modal. No fuzzy library — multi-token AND substring match. The index is
// rebuilt from the controller's state on every open, and again whenever the
// state changes while open.
//
// Lifecycle: `mountCommandPalette` returns a handle with open/close/toggle/
// isOpen/dispose. Dispose tears down any open DOM nodes and listeners. The
// global Cmd-P keybinding lives in `shared/keyboard/shortcuts.ts`; this module
// only owns the modal itself.
// ---------------------------------------------------------------------------

export interface CommandPaletteOptions {
  controller: WorkspacesController;
}

export interface CommandPaletteHandle {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  dispose(): void;
}

export function mountCommandPalette(opts: CommandPaletteOptions): CommandPaletteHandle {
  const { controller } = opts;

  let backdrop: HTMLDivElement | null = null;
  let input: HTMLInputElement | null = null;
  let listEl: HTMLDivElement | null = null;
  let unsubscribeState: (() => void) | null = null;

  let items: PaletteItem[] = [];
  let filtered: PaletteItem[] = [];
  let selectedIdx = 0;
  let disposed = false;

  const isOpen = (): boolean => backdrop !== null;

  const buildIndex = (state: WorkspacesState): PaletteItem[] => {
    const out: PaletteItem[] = [];
    for (const ws of state.workspaces) {
      const wsColor: ColorToken = ws.color ?? deriveFallbackColor(ws.id);
      for (const p of ws.projects) {
        const color: ColorToken = p.color ?? wsColor;
        out.push({
          projectId: p.id,
          projectName: p.name,
          workspaceName: ws.name,
          color,
          haystack: `${ws.name} ${p.name}`.toLowerCase(),
        });
      }
    }
    return out;
  };

  const filterItems = (query: string): PaletteItem[] => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    // Multi-token AND: every whitespace-separated chunk must be present in
    // the haystack. Cheap and good enough — no fuzzy library.
    const tokens = q.split(/\s+/u).filter(Boolean);
    return items.filter((it) => tokens.every((t) => it.haystack.includes(t)));
  };

  const clampSelection = (): void => {
    if (filtered.length === 0) {
      selectedIdx = 0;
      return;
    }
    if (selectedIdx >= filtered.length) selectedIdx = filtered.length - 1;
    if (selectedIdx < 0) selectedIdx = 0;
  };

  const repaint = (): void => {
    if (!listEl) return;
    clampSelection();
    renderPaletteList(listEl, filtered, selectedIdx, {
      onHover: (idx) => {
        if (selectedIdx === idx) return;
        selectedIdx = idx;
        updatePaletteSelection(listEl!, selectedIdx);
      },
      onActivate: (idx) => activate(idx),
    });
  };

  const activate = (idx: number): void => {
    const target = filtered[idx];
    if (!target) return;
    controller.setActiveProject(target.projectId);
    close();
  };

  const onInput = (): void => {
    if (!input) return;
    filtered = filterItems(input.value);
    selectedIdx = 0;
    repaint();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length === 0) return;
      selectedIdx = (selectedIdx + 1) % filtered.length;
      if (listEl) updatePaletteSelection(listEl, selectedIdx);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      selectedIdx = (selectedIdx - 1 + filtered.length) % filtered.length;
      if (listEl) updatePaletteSelection(listEl, selectedIdx);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      activate(selectedIdx);
    }
  };

  const open = (): void => {
    if (disposed || isOpen()) return;

    backdrop = document.createElement("div");
    backdrop.className = "cmd-palette-backdrop";
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close();
    });

    const modal = document.createElement("div");
    modal.className = "cmd-palette-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Command palette");

    input = document.createElement("input");
    input.type = "text";
    input.className = "cmd-palette-input";
    input.placeholder = "Search projects…";
    input.setAttribute("aria-label", "Search projects");
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKey);

    listEl = document.createElement("div");
    listEl.className = "cmd-palette-list";
    listEl.setAttribute("role", "listbox");

    modal.append(input, listEl);
    backdrop.append(modal);
    document.body.append(backdrop);

    items = buildIndex(controller.getState());
    filtered = items;
    selectedIdx = 0;
    repaint();

    // Keep the index fresh while open — e.g. a project rename from another
    // panel should be reflected immediately.
    unsubscribeState = controller.on((event) => {
      if (event.type !== "state-changed") return;
      items = buildIndex(event.state);
      filtered = filterItems(input?.value ?? "");
      repaint();
    });

    // Focus after the node is in the DOM so the caret lands in the input.
    requestAnimationFrame(() => input?.focus());
  };

  const close = (): void => {
    if (!isOpen()) return;
    unsubscribeState?.();
    unsubscribeState = null;
    input?.removeEventListener("input", onInput);
    input?.removeEventListener("keydown", onKey);
    backdrop?.remove();
    backdrop = null;
    input = null;
    listEl = null;
    items = [];
    filtered = [];
    selectedIdx = 0;
  };

  const toggle = (): void => {
    if (isOpen()) close();
    else open();
  };

  return {
    open,
    close,
    toggle,
    isOpen,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      close();
    },
  };
}
