import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project, ProjectId, WorkspaceId } from "../state/types";
import type { WorkspacesController } from "../state/workspaces-controller";
import { createSelectionStore } from "../state/selection";
import { createProjectRow } from "./project-row";

function project(): Project {
  return {
    id: "p1" as ProjectId,
    name: "polakapi",
    path: "/tmp/polakapi",
  };
}

describe("project row activity", () => {
  afterEach(() => document.body.replaceChildren());

  it("renders activity changes without changing the terminal count", () => {
    const handle = createProjectRow({
      project: project(),
      workspaceId: "w1" as WorkspaceId,
      isActive: true,
      liveTerminalsCount: 3,
      activityState: "working",
      controller: { setActiveProject: vi.fn() } as unknown as WorkspacesController,
      selection: createSelectionStore(),
    });
    document.body.append(handle.element);

    expect(handle.element.dataset.activity).toBe("working");
    expect(handle.element.querySelector(".ws-activity-label")?.textContent).toBe("Running");
    expect(handle.element.querySelector(".ws-terminals-badge")?.textContent).toBe("3");

    handle.setActivity("ready");

    expect(handle.element.dataset.activity).toBe("ready");
    expect(handle.element.querySelector(".ws-activity-label")?.textContent).toBe("Ready");
    expect(handle.element.querySelector(".ws-terminals-badge")?.textContent).toBe("3");
    handle.dispose();
  });

  it("gives attention priority and restores the underlying activity", () => {
    const handle = createProjectRow({
      project: project(),
      workspaceId: "w1" as WorkspaceId,
      isActive: false,
      liveTerminalsCount: 1,
      activityState: "ready",
      controller: {} as WorkspacesController,
      selection: createSelectionStore(),
    });

    handle.setBellPending(true);
    expect(handle.element.dataset.activity).toBe("attention");
    expect(handle.element.querySelector(".ws-activity-label")?.textContent).toBe("Attention");

    handle.setBellPending(false);
    expect(handle.element.dataset.activity).toBe("ready");
    expect(handle.element.querySelector(".ws-activity-label")?.textContent).toBe("Ready");
    handle.dispose();
  });
});
