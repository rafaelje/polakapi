export interface ListenerBag {
  on<T extends Event>(this: void, el: EventTarget, type: string, handler: (event: T) => void): void;
  dispose(this: void): void;
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
