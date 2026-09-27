import { getCurrentWindow } from "@tauri-apps/api/window";
import { requireById } from "../../shared/dom/dom";
import { mountAgentPanel } from "./agent/agent-panel";
import { mountBranchPanel, type BranchPanel } from "./branch-tab/branch-panel";
import { mountBranchSync } from "./branches/branch-sync";
import { mountChangesPanel, type ChangesPanel } from "./changes/changes-panel";
import { mountCommitBox } from "./changes/commit-box";
import { codeReviewKeyAction, readPinnedProject } from "./code-review-model";
import { mountCodeReviewLayout, type CodeReviewLayout } from "./code-review-layout";
import { renderEmpty } from "./dom";
import { onProjectChanged, watchProjectChanges } from "./project-changes";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest(".code-review-agent")) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function wireKeyboard(layout: CodeReviewLayout, changes: ChangesPanel, branch: BranchPanel): void {
  document.addEventListener("keydown", (event) => {
    const ignored = event.defaultPrevented || isTypingTarget(event.target);
    const action = ignored ? null : codeReviewKeyAction(event);
    if (action !== "discard") changes.disarm();
    if (!action) return;
    event.preventDefault();
    if (action === "close") {
      void getCurrentWindow().close();
      return;
    }
    const onBranch = layout.activeTab() === "branch";
    if (action === "refresh") {
      void (onBranch ? branch.refresh() : changes.refresh());
      return;
    }
    if (onBranch) {
      if (action === "next" || action === "previous") branch.move(action === "next" ? 1 : -1);
      return;
    }
    if (action === "toggle-stage") void changes.toggleStage();
    else if (action === "stage-all") void changes.stageAll();
    else if (action === "discard") void changes.discard();
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
  const branch = mountBranchPanel({
    project,
    list: layout.list,
    diff: layout.diff,
    basePicker: layout.basePicker,
    isVisible: () => layout.activeTab() === "branch",
  });

  layout.onTabChange((tab) => {
    commitBox.setVisible(tab === "changes");
    changes.disarm();
    if (tab === "changes") {
      changes.render();
      return;
    }
    branch.render();
    void branch.refresh();
  });
  layout.refreshButton.addEventListener("click", () => {
    void (layout.activeTab() === "branch" ? branch.refresh() : changes.refresh());
  });
  layout.stageAllButton.addEventListener("click", () => void changes.stageAll());
  mountBranchSync({
    project,
    onTabChange: (listener) => layout.onTabChange(listener),
    onChanged: async () => {
      await Promise.all([
        changes.refresh(),
        layout.activeTab() === "branch" ? branch.refresh() : Promise.resolve(),
      ]);
    },
  });
  wireKeyboard(layout, changes, branch);
  onProjectChanged(() => {
    void changes.refresh();
    if (layout.activeTab() === "branch") void branch.refresh();
  });

  changes.render();
  void changes.refresh();
  void watchProjectChanges(project.path);
}

bootstrap();
