const VIEWPORT_MARGIN = 8;

export function clampPopoverToViewport(popover: HTMLElement): void {
  const rect = popover.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - VIEWPORT_MARGIN;
  const maxTop = window.innerHeight - rect.height - VIEWPORT_MARGIN;
  popover.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft))}px`;
  popover.style.top = `${Math.max(VIEWPORT_MARGIN, Math.min(rect.top, maxTop))}px`;
}
