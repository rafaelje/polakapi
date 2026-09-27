import { getCurrentWindow } from "@tauri-apps/api/window";
import { requireById } from "../../shared/dom/dom";
import { mountAgentPanel } from "./agent/agent-panel";
import { mountBranchSync } from "./branches/branch-sync";
import { mountChangesPanel, type ChangesPanel } from "./changes/changes-panel";
import { mountCommitBox } from "./changes/commit-box";
import { codeReviewKeyAction, readPinnedProject } from "./code-review-model";
import { mountCodeReviewLayout, type CodeReviewLayout } from "./code-review-layout";
import { renderEmpty } from "./dom";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest(".code-review-agent")) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function showBranchPlaceholder(layout: CodeReviewLayout): void {
  renderEmpty(layout.list, "The Branch view is not available yet.");
  renderEmpty(layout.diff, "Select a file to see its diff.");
}

function wireKeyboard(layout: CodeReviewLayout, changes: ChangesPanel): void {
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || isTypingTarget(event.target)) return;
    const action = codeReviewKeyAction(event);
    if (!action) return;
    event.preventDefault();
    if (action === "close") {
      void getCurrentWindow().close();
      return;
    }
    if (action === "refresh") {
      void changes.refresh();
      return;
    }
    if (layout.activeTab() !== "changes") return;
    if (action === "toggle-stage") void changes.toggleStage();
    else if (action === "stage-all") void changes.stageAll();
    else changes.move(action === "next" ? 1 : -1);
  });
}

function bootstrap(): void {
  const project = readPinnedProject(window.location.search);
  if (!project) {
    renderEmpty(document.body, "No project was given to /code-review.", true);
    return;
  }
  const layout = mountCodeReviewLayout(project);
  const agent = mountAgentPanel(requireById("code-review-agent"), project.path);
  window.addEventListener("pagehide", () => void agent.dispose());
  const changes = mountChangesPanel({
    project,
    list: layout.list,
    diff: layout.diff,
    isVisible: () => layout.activeTab() === "changes",
    onBranch: (branch) => layout.setBranch(branch),
  });

  const commitBox = mountCommitBox(project, changes);

  layout.onTabChange((tab) => {
    commitBox.setVisible(tab === "changes");
    if (tab === "changes") changes.render();
    else showBranchPlaceholder(layout);
  });
  layout.refreshButton.addEventListener("click", () => void changes.refresh());
  layout.stageAllButton.addEventListener("click", () => void changes.stageAll());
  mountBranchSync({
    project,
    onTabChange: (listener) => layout.onTabChange(listener),
    onChanged: () => changes.refresh(),
  });
  wireKeyboard(layout, changes);

  changes.render();
  void changes.refresh();
}

bootstrap();
