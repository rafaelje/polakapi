import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectId, WorkspaceId, WorkspacesState } from "../state/types";
import type { WorkspacesController } from "../state/workspaces-controller";
import { mountWorkspacesPanel, type LiveCountEvent } from "./workspaces-panel";

vi.mock("../drag-drop/drag-drop", () => ({
  attach: () => ({ detach: vi.fn() }),
}));

vi.mock("../drag-drop/finder-drop", () => ({
  attachFinderDrop: () => ({ detach: vi.fn() }),
}));

const activeId = "p1" as ProjectId;
const idleId = "p2" as ProjectId;

function state(): WorkspacesState {
  return {
    schemaVersion: 1,
    activeProjectId: activeId,
    workspaces: [
      {
        id: "w1" as WorkspaceId,
        name: "Product",
        projects: [{ id: activeId, name: "polakapi", path: "/tmp/polakapi" }],
      },
      {
        id: "w2" as WorkspaceId,
        name: "Services",
        projects: [{ id: idleId, name: "billing", path: "/tmp/billing" }],
      },
    ],
  };
}

describe("workspaces panel active filter", () => {
  afterEach(() => document.body.replaceChildren());

  it("shows only projects with live terminals and reacts to count changes", () => {
    const counts = new Map<ProjectId, number>([
      [activeId, 1],
      [idleId, 0],
    ]);
    const terminalListeners = new Set<(event: LiveCountEvent) => void>();
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    const root = document.createElement("aside");
    document.body.append(toggle, root);

    const handle = mountWorkspacesPanel({
      root,
      activeOnlyToggle: toggle,
      controller: {
        getState: state,
        areAllCollapsed: () => false,
        on: () => () => undefined,
      } as unknown as WorkspacesController,
      liveCounts: {
        getCount: (projectId) => counts.get(projectId) ?? 0,
        liveCountsByProject: () => counts,
        on: (listener) => {
          terminalListeners.add(listener);
          return () => terminalListeners.delete(listener);
        },
      },
    });

    expect(root.querySelectorAll(".ws-project-row")).toHaveLength(2);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));

    expect(root.querySelectorAll(".ws-project-row")).toHaveLength(1);
    expect(root.querySelector(".ws-project-name")?.textContent).toBe("polakapi");
    expect(root.querySelectorAll(".ws-workspace")).toHaveLength(1);

    counts.set(activeId, 0);
    counts.set(idleId, 1);
    for (const listener of terminalListeners) {
      listener({ type: "counts-changed", counts });
    }

    expect(root.querySelectorAll(".ws-project-row")).toHaveLength(1);
    expect(root.querySelector(".ws-project-name")?.textContent).toBe("billing");
    handle.unmount();
  });
});
