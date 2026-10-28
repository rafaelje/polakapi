import { requireById } from "../../../shared/dom/dom";
import { commitStaged } from "../api";
import type { PinnedProject } from "../types";
import type { ChangesPanel } from "./changes-panel";
import { canCommit, isCommitShortcut } from "./commit-model";

export interface CommitBox {
  setVisible(visible: boolean): void;
}

export function mountCommitBox(project: PinnedProject, changes: ChangesPanel): CommitBox {
  const form = requireById("code-review-commit", HTMLFormElement);
  const message = requireById("code-review-commit-message", HTMLTextAreaElement);
  const button = requireById("code-review-commit-button", HTMLButtonElement);
  const status = requireById("code-review-commit-status");

  const update = (): void => {
    const stagedCount = changes.stagedCount();
    button.disabled = !canCommit({
      stagedCount,
      message: message.value,
      busy: changes.isBusy(),
    });
    button.title = stagedCount === 0 ? "Stage files to commit" : "Commit (ctrl/cmd+enter)";
  };

  const commit = async (): Promise<void> => {
    if (button.disabled) return;
    const text = message.value;
    let hash = "";
    status.textContent = "";
    const committed = await changes.runAction("commit", async () => {
      hash = await commitStaged(project.path, text);
    });
    if (committed) {
      message.value = "";
      status.textContent = `Committed ${hash}`;
    }
    update();
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void commit();
  });
  message.addEventListener("input", update);
  message.addEventListener("keydown", (event) => {
    if (!isCommitShortcut(event)) return;
    event.preventDefault();
    void commit();
  });
  changes.onUpdate(update);
  update();

  return {
    setVisible: (visible) => {
      form.hidden = !visible;
    },
  };
}
