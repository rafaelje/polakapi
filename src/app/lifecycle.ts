export interface WindowLifecycleHandlers {
  onBeforeUnload: () => void;
  onResize: () => void;
}

export function wireWindowLifecycle(handlers: WindowLifecycleHandlers): () => void {
  window.addEventListener("beforeunload", handlers.onBeforeUnload);
  window.addEventListener("resize", handlers.onResize);

  return () => {
    window.removeEventListener("beforeunload", handlers.onBeforeUnload);
    window.removeEventListener("resize", handlers.onResize);
  };
}
