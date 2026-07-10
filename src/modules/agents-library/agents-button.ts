import type { AgentsController } from "./agents-controller";
import { mountAgentsModal } from "./agents-modal";
import type { InsertTarget, TerminalRouterLookup } from "./insert-target";

const BUTTON_ID = "open-agents";

export interface AgentsButtonHandle {
  dispose(): void;
  openModal(): void;
}

export interface AgentsButtonOptions {
  controller: AgentsController;
  router: TerminalRouterLookup;
  onAfterInsert?: (target: InsertTarget) => void;
}

export function mountAgentsButton(opts: AgentsButtonOptions): AgentsButtonHandle {
  const btn = document.getElementById(BUTTON_ID);
  const modal = mountAgentsModal({
    controller: opts.controller,
    router: opts.router,
    onAfterInsert: opts.onAfterInsert,
  });
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
