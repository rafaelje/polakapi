import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project } from "../modules/workspaces/state/types";
import { mountProjectPane, type ProjectPaneCallbacks } from "./project-pane";

function callbacks(): ProjectPaneCallbacks {
  return {
    onAddTerminal: vi.fn(),
    onOpenLayoutsMenu: vi.fn(),
    onSuspendAll: vi.fn(),
    onResumeAll: vi.fn(),
    onOpenInWindow: vi.fn(),
    onBringBack: vi.fn(),
    onRunInAll: vi.fn(),
    onCloseAll: vi.fn(),
    onReloadAll: vi.fn(),
    onClearContextData: vi.fn(),
    onRevealFolder: vi.fn(),
    onOpenInEditor: vi.fn(),
    onOpenInShell: vi.fn(),
    onSetActiveCli: vi.fn(),
  };
}

function project(path = "/tmp/simple-c"): Project {
  return {
    id: "project-1" as Project["id"],
    name: "simple-c",
    path,
  };
}

function mount() {
  const host = document.createElement("div");
  const grid = document.createElement("div");
  grid.id = "grid";
  host.append(grid);
  document.body.append(host);
  const handlers = callbacks();
  const pane = mountProjectPane({ host, gridEl: grid, callbacks: handlers });
  return { host, grid, handlers, pane };
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>(".project-toolbar-menu-item")].find(
    (button) => button.textContent === label,
  );
  if (!item) throw new Error(`Menu item not found: ${label}`);
  return item;
}

describe("project toolbar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("starts the selected terminal from one split control", () => {
    const { handlers, pane } = mount();
    pane.setActiveProject(project());
    pane.setActiveCli("codex");

    const start = document.querySelector<HTMLButtonElement>("#add-pane");
    expect(start?.textContent).toBe("Start Codex");
    start?.click();

    expect(handlers.onAddTerminal).toHaveBeenCalledOnce();
  });

  it("changes the active profile from the integrated menu", () => {
    const { handlers, pane } = mount();
    pane.setActiveProject(project());
    pane.setActiveCli("codex");

    document.querySelector<HTMLButtonElement>("#terminal-profile-menu")?.click();
    const claude = document.querySelector<HTMLButtonElement>('[data-cli-id="claude"]');
    expect(claude?.getAttribute("role")).toBe("menuitemradio");
    claude?.click();

    expect(document.querySelector("#add-pane")?.textContent).toBe("Start Claude");
    expect(handlers.onSetActiveCli).toHaveBeenCalledExactlyOnceWith("claude");
    expect(document.querySelector(".project-toolbar-popover")).toBeNull();
  });

  it("closes menus with Escape and returns focus to the trigger", () => {
    const { pane } = mount();
    pane.setActiveProject(project());

    const trigger = document.querySelector<HTMLButtonElement>("#terminal-profile-menu");
    trigger?.click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(document.querySelector(".project-toolbar-popover")).toBeNull();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("groups project actions without changing their behavior", () => {
    const { handlers, pane } = mount();
    pane.setActiveProject(project());

    const actions = document.querySelector<HTMLButtonElement>("#project-actions-menu");
    actions?.click();
    menuItem("Run command in all…").click();
    expect(handlers.onRunInAll).toHaveBeenCalledOnce();

    actions?.click();
    menuItem("Open in terminal").click();
    expect(handlers.onOpenInShell).toHaveBeenCalledExactlyOnceWith("/tmp/simple-c");

    actions?.click();
    menuItem("Layouts…").click();
    expect(handlers.onOpenLayoutsMenu).toHaveBeenCalledExactlyOnceWith(actions);
  });

  it("offers close all and reload all from the actions menu", () => {
    const { handlers, pane } = mount();
    pane.setActiveProject(project());

    const actions = document.querySelector<HTMLButtonElement>("#project-actions-menu");
    actions?.click();
    menuItem("Reload all").click();
    expect(handlers.onReloadAll).toHaveBeenCalledOnce();

    actions?.click();
    menuItem("Close all").click();
    expect(handlers.onCloseAll).toHaveBeenCalledOnce();
  });

  it("offers clearing context mode data from the actions menu", () => {
    const { handlers, pane } = mount();
    pane.setActiveProject(project());

    document.querySelector<HTMLButtonElement>("#project-actions-menu")?.click();
    menuItem("Clear context mode data…").click();
    expect(handlers.onClearContextData).toHaveBeenCalledOnce();
  });

  it("leaves suspend all as the only batch action with its own button", () => {
    const { pane } = mount();
    pane.setActiveProject(project());

    const labels = [...document.querySelectorAll(".project-pane-toolbar button")].map(
      (button) => button.textContent ?? "",
    );
    expect(labels).toContain("⏸ Suspend all");
    expect(labels.some((label) => label.includes("Close all"))).toBe(false);
    expect(labels.some((label) => label.includes("Reload all"))).toBe(false);
  });

  it("moves the grid to its own window and back from the project actions menu", () => {
    const { handlers, pane } = mount();
    pane.setActiveProject(project());
    const actions = document.querySelector<HTMLButtonElement>("#project-actions-menu")!;

    expect(document.querySelector("#open-in-window")).toBeNull();
    actions.click();
    menuItem("Open in window").click();
    expect(handlers.onOpenInWindow).toHaveBeenCalledOnce();

    pane.setDetached(true);
    // Nothing can be started here while the terminals live elsewhere.
    expect(document.querySelector<HTMLButtonElement>("#add-pane")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#suspend-all")?.disabled).toBe(true);
    actions.click();
    menuItem("Bring back").click();
    expect(handlers.onBringBack).toHaveBeenCalledOnce();

    pane.setDetached(false);
    expect(document.querySelector<HTMLButtonElement>("#add-pane")?.disabled).toBe(false);
  });

  it("keeps the toolbar focused on terminal controls", () => {
    const { pane } = mount();
    pane.setActiveProject(project());

    expect(document.querySelector("#project-command-center")).toBeNull();
    expect(document.querySelector("#add-pane")).not.toBeNull();
    expect(document.querySelector("#project-actions-menu")).not.toBeNull();
  });

  it("keeps terminal counts and suspend or resume state synchronized", () => {
    const { handlers, pane } = mount();
    pane.setActiveProject(project());
    pane.setSuspendResumeCounts(2, 1);

    expect(document.querySelector(".project-toolbar-status")?.textContent).toBe(
      "2 running · 1 suspended",
    );
    const suspend = document.querySelector<HTMLButtonElement>("#suspend-all");
    expect(suspend?.classList.contains("hidden")).toBe(false);
    suspend?.click();
    expect(handlers.onSuspendAll).toHaveBeenCalledOnce();

    pane.setSuspendResumeCounts(0, 3);
    expect(document.querySelector(".project-toolbar-status")?.textContent).toBe("3 suspended");
    const resume = document.querySelector<HTMLButtonElement>("#resume-all");
    expect(resume?.classList.contains("hidden")).toBe(false);
    resume?.click();
    expect(handlers.onResumeAll).toHaveBeenCalledOnce();

    document.querySelector<HTMLButtonElement>("#project-actions-menu")?.click();
    expect(menuItem("Resume all")).toBeTruthy();
  });

  it("disables project controls until a project is active", () => {
    const { pane } = mount();
    const controls = ["#add-pane", "#terminal-profile-menu", "#project-actions-menu"];

    expect(
      controls.every((selector) => document.querySelector<HTMLButtonElement>(selector)?.disabled),
    ).toBe(true);

    pane.setActiveProject(project());
    expect(
      controls.every((selector) => !document.querySelector<HTMLButtonElement>(selector)?.disabled),
    ).toBe(true);
  });
});
