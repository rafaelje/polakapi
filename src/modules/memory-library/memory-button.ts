import { mountMemoryModal, type MemoryModalDeps } from "./memory-modal";

const BUTTON_ID = "open-memory";

export interface MemoryButtonHandle {
  dispose(): void;
  openModal(): void;
}

export function mountMemoryButton(deps: MemoryModalDeps): MemoryButtonHandle {
  const btn = document.getElementById(BUTTON_ID);
  const modal = mountMemoryModal(deps);
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
