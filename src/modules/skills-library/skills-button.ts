import { mountSkillsModal } from "./skills-modal";

const BUTTON_ID = "open-skills";

export interface SkillsButtonHandle {
  dispose(): void;
  openModal(): void;
}

export function mountSkillsButton(): SkillsButtonHandle {
  const btn = document.getElementById(BUTTON_ID);
  const modal = mountSkillsModal();
  if (!(btn instanceof HTMLButtonElement)) {
    return { dispose: () => modal.dispose(), openModal: () => modal.open() };
  }
  const onClick = (): void => modal.open();
  btn.addEventListener("click", onClick);
  return {
    openModal: () => modal.open(),
    dispose: () => {
      btn.removeEventListener("click", onClick);
      modal.dispose();
    },
  };
}
