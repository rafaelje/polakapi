const MIN_PANE_PX = 80;
const MIN_SIDEBAR_PX = 120;
const MAX_SIDEBAR_PX = 600;

export type SidebarTarget = "sidebar-left" | "sidebar-right";

export function makeFlexGutter(orientation: "h" | "v", onResize: () => void): HTMLElement {
  const g = document.createElement("div");
  g.className = `gutter gutter-${orientation}`;
  g.addEventListener("mousedown", (e) => startFlexDrag(e, g, orientation, onResize));
  return g;
}

export function startFlexDrag(
  e: MouseEvent,
  gutter: HTMLElement,
  orientation: "h" | "v",
  onResize: () => void,
): void {
  e.preventDefault();
  const prev = gutter.previousElementSibling as HTMLElement | null;
  const next = gutter.nextElementSibling as HTMLElement | null;
  if (!prev || !next) return;
  const horiz = orientation === "h";
  const rectPrev = prev.getBoundingClientRect();
  const rectNext = next.getBoundingClientRect();
  const startSize = horiz ? rectPrev.width : rectPrev.height;
  const sumSize = startSize + (horiz ? rectNext.width : rectNext.height);
  const startPos = horiz ? e.clientX : e.clientY;
  gutter.classList.add("dragging");
  document.body.style.cursor = horiz ? "col-resize" : "row-resize";
  document.body.style.userSelect = "none";

  const onMove = (ev: MouseEvent): void => {
    const delta = (horiz ? ev.clientX : ev.clientY) - startPos;
    let newPrev = startSize + delta;
    newPrev = Math.max(MIN_PANE_PX, Math.min(sumSize - MIN_PANE_PX, newPrev));
    const newNext = sumSize - newPrev;
    prev.style.flex = `0 0 ${newPrev}px`;
    next.style.flex = `0 0 ${newNext}px`;
    onResize();
  };
  const onUp = (): void => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    gutter.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    onResize();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

export function startSidebarDrag(
  e: MouseEvent,
  gutter: HTMLElement,
  target: HTMLElement,
  side: SidebarTarget,
  onResize: () => void,
): void {
  e.preventDefault();
  const startWidth = target.getBoundingClientRect().width;
  const startX = e.clientX;
  const dir = side === "sidebar-left" ? 1 : -1;
  gutter.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  const onMove = (ev: MouseEvent): void => {
    const delta = (ev.clientX - startX) * dir;
    const w = Math.max(MIN_SIDEBAR_PX, Math.min(MAX_SIDEBAR_PX, startWidth + delta));
    target.style.width = `${w}px`;
    onResize();
  };
  const onUp = (): void => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    gutter.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    onResize();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

export function wireSidebarGutters(
  sidebars: Record<SidebarTarget, HTMLElement>,
  onResize: () => void,
): void {
  document.querySelectorAll<HTMLElement>(".gutter[data-resize]").forEach((g) => {
    const target = g.dataset.resize as SidebarTarget | undefined;
    if (!target) return;
    g.addEventListener("mousedown", (e) =>
      startSidebarDrag(e, g, sidebars[target], target, onResize),
    );
  });
}

export interface ToggleBinding {
  btnId: string;
  target: HTMLElement;
  cls: string;
}

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
