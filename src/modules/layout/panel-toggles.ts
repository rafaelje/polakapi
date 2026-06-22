import { type ToggleBinding } from "./types";

export function wireToggles(bindings: ToggleBinding[], onChange: () => void): void {
  for (const { btnId, target, cls } of bindings) {
    const btn = document.getElementById(btnId) as HTMLButtonElement | null;
    if (!btn) continue;
    btn.addEventListener("click", () => {
      const willHide = !target.classList.contains(cls);
      target.classList.toggle(cls, willHide);
      btn.classList.toggle("active", !willHide);
      requestAnimationFrame(onChange);
    });
  }
}
