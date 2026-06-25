/**
 * Tiny helper that tracks every `addEventListener` call so a mount function
 * can wipe them all in one shot at dispose-time. Replaces the ad-hoc
 * `handlers: Array<{el,type,handler}>` block that was duplicated verbatim in
 * step1-chat, step2-phases, step3-setup, and step3-run.
 *
 * Usage:
 *   const listeners = createListenerBag();
 *   listeners.on(btn, "click", () => …);
 *   listeners.on(window, "keydown", (e: KeyboardEvent) => …);
 *   …
 *   listeners.dispose();  // removes every registered listener
 */
export interface ListenerBag {
  /** Register an event listener that will be removed on `dispose()`. */
  on<T extends Event>(
    el: EventTarget,
    type: string,
    handler: (event: T) => void,
  ): void;
  /** Remove every listener registered via `on()` and clear the internal list. */
  dispose(): void;
}

interface Tracked {
  el: EventTarget;
  type: string;
  handler: EventListenerOrEventListenerObject;
}

export function createListenerBag(): ListenerBag {
  const tracked: Tracked[] = [];
  return {
    on<T extends Event>(el: EventTarget, type: string, handler: (event: T) => void): void {
      const wrapped = handler as EventListenerOrEventListenerObject;
      el.addEventListener(type, wrapped);
      tracked.push({ el, type, handler: wrapped });
    },
    dispose(): void {
      for (const { el, type, handler } of tracked) {
        el.removeEventListener(type, handler);
      }
      tracked.length = 0;
    },
  };
}
