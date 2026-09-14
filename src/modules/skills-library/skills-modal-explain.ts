import { modalCloseButton } from "../../shared/ui/modal";
import { defaultExplainModelFor, type ExplainCli, type SkillEntry } from "./types";

// The /skills explain view: run status, agent output, and the cli + model
// controls for re-running it. Split out of skills-modal.ts to keep that file
// within the module line budget enforced by src/architecture.

export interface ExplainState {
  skill: SkillEntry;
  cli: ExplainCli;
  running: boolean;
  /** Editable per run; seeded from the CLI default and reset when the CLI
   *  changes, mirroring the /loop and /adversarial setup forms. */
  model: string;
  text: string | null;
  error: string | null;
  /** Epoch ms the current run started, for the elapsed counter. */
  startedAt: number;
}

export interface ExplainViewDeps {
  makeCliSelect: (onChange: (cli: ExplainCli) => void) => HTMLSelectElement;
  /** The modal owns the interval so exactly one is ever live. */
  registerTicker: (paint: () => void) => void;
  onRerun: () => void;
  onBack: () => void;
  onEdit: () => void;
  onClose: () => void;
}

export function renderExplainMode(
  modal: HTMLElement,
  current: ExplainState,
  deps: ExplainViewDeps,
): void {
  const head = document.createElement("div");
  head.className = "agents-modal-head";
  const title = document.createElement("strong");
  title.className = "agents-modal-editor-title";
  title.textContent = `explain: ${current.skill.name}`;
  const badge = document.createElement("span");
  badge.className = "skills-modal-cli-badge";
  badge.dataset.cli = current.skill.cli;
  badge.textContent = current.skill.cli;
  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "agents-modal-btn";
  backBtn.textContent = "back";
  backBtn.addEventListener("click", deps.onBack);
  head.append(title, badge, spacer, backBtn, modalCloseButton(deps.onClose));

  const body = document.createElement("div");
  body.className = "skills-modal-explain-body";

  // The skill is sent to an agent that runs in the skill's own directory. The
  // run is read-only, but the content still reaches a model — say so plainly
  // rather than leaving the user to infer it.
  const notice = document.createElement("div");
  notice.className = "skills-modal-explain-notice";
  notice.textContent =
    `Sends this file to ${current.cli}, which runs read-only in the skill's ` +
    `directory. A skill from a source you do not trust is still worth reading yourself first.`;
  body.append(notice);

  if (current.running) {
    const status = document.createElement("div");
    status.className = "skills-modal-explain-status";

    const spinner = document.createElement("span");
    spinner.className = "skills-modal-spinner";
    spinner.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.textContent = `Asking ${current.cli} to read and explain this skill…`;

    // A run can take minutes, so a static line reads as a hung window. The
    // counter is what tells the user it is still going.
    const elapsed = document.createElement("span");
    elapsed.className = "skills-modal-explain-elapsed";
    const paintElapsed = (): void => {
      elapsed.textContent = formatElapsed(Date.now() - current.startedAt);
    };
    paintElapsed();
    deps.registerTicker(paintElapsed);

    status.append(spinner, label, elapsed);
    status.setAttribute("role", "status");
    body.append(status);
  } else if (current.error) {
    const error = document.createElement("div");
    error.className = "agents-modal-editor-error";
    error.textContent = current.error;
    body.append(error);
  }
  if (current.text) {
    const output = document.createElement("pre");
    output.className = "agents-modal-preview-body skills-modal-explain-output";
    output.textContent = current.text;
    body.append(output);
  }

  const actions = document.createElement("div");
  actions.className = "agents-modal-actions";

  const modelInput = document.createElement("input");
  modelInput.type = "text";
  modelInput.className = "skills-modal-model-input";
  modelInput.setAttribute("aria-label", "Model used to explain the skill");
  modelInput.value = current.model;
  modelInput.disabled = current.running;
  modelInput.addEventListener("input", () => {
    current.model = modelInput.value;
  });

  const cliSelect = deps.makeCliSelect((cli) => {
    current.cli = cli;
    // A model name is CLI-specific, so carrying the old one over would just
    // produce a rejected-model error on the next run.
    current.model = defaultExplainModelFor(cli);
    modelInput.value = current.model;
  });
  cliSelect.disabled = current.running;

  const rerunBtn = document.createElement("button");
  rerunBtn.type = "button";
  rerunBtn.className = "agents-modal-btn agents-modal-btn-primary";
  rerunBtn.textContent = current.running ? "running…" : "run again";
  rerunBtn.disabled = current.running || current.model.trim() === "";
  rerunBtn.addEventListener("click", deps.onRerun);

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "agents-modal-btn";
  editBtn.textContent = "edit skill";
  editBtn.addEventListener("click", deps.onEdit);

  const modelLabel = document.createElement("span");
  modelLabel.className = "skills-modal-cli-label";
  modelLabel.textContent = "model";

  actions.append(cliSelect, modelLabel, modelInput, rerunBtn, editBtn);

  modal.append(head, body, actions);

  modal.append(head, body, actions);
}

/** `12s`, then `1:05` once past a minute. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
