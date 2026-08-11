import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectActivityState } from "../../terminal/project-activity";
import { createSelectionStore } from "../state/selection";
import type { FolderId, ProjectId, Workspace, WorkspaceId } from "../state/types";
import type { WorkspacesController } from "../state/workspaces-controller";
import { createWorkspaceRow } from "./workspace-row";

const firstId = "p1" as ProjectId;
const secondId = "p2" as ProjectId;

function workspace(): Workspace {
  return {
    id: "w1" as WorkspaceId,
    name: "Products",
    projects: [
      { id: firstId, name: "polakapi", path: "/tmp/polakapi" },
      { id: secondId, name: "billing", path: "/tmp/billing" },
    ],
  };
}

describe("workspace row activity summary", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("summarizes project activity and gives attention priority", () => {
    const states = new Map<ProjectId, ProjectActivityState>([
      [firstId, "working"],
      [secondId, "idle"],
    ]);
    const handle = createWorkspaceRow({
      workspace: workspace(),
      controller: {
        getState: () => ({ activeProjectId: null }),
      } as unknown as WorkspacesController,
      activityFor: (id) => states.get(id) ?? "idle",
      selection: createSelectionStore(),
    });
    document.body.append(handle.element);
    const summary = handle.element.querySelector<HTMLElement>(".ws-workspace-activity");

    expect(summary?.dataset.activity).toBe("working");
    expect(summary?.textContent).toContain("1 working");

    handle.setActivity(firstId, "ready");
    expect(summary?.dataset.activity).toBe("ready");
    expect(summary?.textContent).toContain("1 active");

    handle.setBellPending(secondId, true);
    expect(summary?.dataset.activity).toBe("attention");
    expect(summary?.textContent).toContain("1 needs attention");

    handle.setBellPending(secondId, false);
    expect(summary?.dataset.activity).toBe("ready");

    handle.setActivity("outside" as ProjectId, "working");
    handle.setBellPending("outside" as ProjectId, true);
    expect(summary?.dataset.activity).toBe("ready");
    expect(summary?.textContent).toContain("1 active");
    handle.dispose();
  });

  it("collapses on a single name click", () => {
    vi.useFakeTimers();
    const toggleCollapsed = vi.fn();
    const handle = createWorkspaceRow({
      workspace: workspace(),
      controller: {
        getState: () => ({ activeProjectId: null }),
        toggleCollapsed,
      } as unknown as WorkspacesController,
      selection: createSelectionStore(),
    });
    const name = handle.element.querySelector<HTMLElement>(".ws-workspace-name");

    name?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(toggleCollapsed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(280);

    expect(toggleCollapsed).toHaveBeenCalledExactlyOnceWith("w1");
    handle.dispose();
  });

  it("renames on a double name click without collapsing", async () => {
    vi.useFakeTimers();
    const toggleCollapsed = vi.fn();
    const renameWorkspace = vi.fn();
    const handle = createWorkspaceRow({
      workspace: workspace(),
      controller: {
        getState: () => ({ activeProjectId: null }),
        toggleCollapsed,
        renameWorkspace,
      } as unknown as WorkspacesController,
      selection: createSelectionStore(),
    });
    const name = handle.element.querySelector<HTMLElement>(".ws-workspace-name");

    name?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    name?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    name?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    const input = name?.querySelector<HTMLInputElement>(".ws-rename-input");
    if (input) input.value = "Platform";
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    vi.runAllTimers();

    expect(toggleCollapsed).not.toHaveBeenCalled();
    expect(renameWorkspace).toHaveBeenCalledExactlyOnceWith("w1", "Platform");
    expect(name?.getAttribute("role")).toBe("button");
    handle.dispose();
  });

  it("filters projects inside and outside folders", () => {
    const data = workspace();
    const folderId = "f1" as FolderId;
    data.folders = [{ id: folderId, name: "Services" }];
    data.projects[1].folderId = folderId;
    const handle = createWorkspaceRow({
      workspace: data,
      controller: {
        getState: () => ({ activeProjectId: null }),
      } as unknown as WorkspacesController,
      projectFilter: (project) => project.id === secondId,
      selection: createSelectionStore(),
    });

    expect(handle.element.querySelectorAll(".ws-project-row")).toHaveLength(1);
    expect(handle.element.querySelector(".ws-project-name")?.textContent).toBe("billing");
    expect(handle.element.querySelectorAll(".ws-folder")).toHaveLength(1);
    handle.dispose();
  });
});
