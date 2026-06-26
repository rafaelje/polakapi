import { createListenerBag } from "../shared/listener-bag";

import type { Step3RunContext, Step3RunHandle } from "./state";
import { renderView } from "./view";

export type { Step3RunContext, Step3RunHandle } from "./state";

export function mountStep3Run(slot: HTMLElement, ctx: Step3RunContext): Step3RunHandle {
  slot.classList.add("loop-step3-run");

  const root = document.createElement("div");
  root.className = "loop-step3-run-root";
  slot.replaceChildren(root);

  const listeners = createListenerBag();
  const { on } = listeners;

  const unsubscribe = ctx.scheduler.on((state) => {
    renderView(root, state, ctx, on);
  });

  return {
    dispose: () => {
      unsubscribe();
      listeners.dispose();
      slot.classList.remove("loop-step3-run");
    },
  };
}
