import { promptModal } from "../../shared/ui/modal";
import { showToast } from "../../shared/ui/toast";
import type { PaneMenuHandle } from "./terminal-pane-menu";

export interface MemorySettingsMenuOptions {
  trigger: HTMLElement;
  limitMb: number;
  idleMinutes: number;
  onLimitChange(mb: number): void;
  onIdleChange(minutes: number): void;
}

export function openMemorySettingsMenu(opts: MemorySettingsMenuOptions): PaneMenuHandle {
  document.querySelectorAll(".pane-menu-popover").forEach((node) => node.remove());

  const popover = document.createElement("div");
  popover.className = "pane-menu-popover";
  const rect = opts.trigger.getBoundingClientRect();
  popover.style.position = "fixed";
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.left = `${Math.max(8, rect.right - 260)}px`;

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    popover.remove();
    window.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", dispose);
    window.removeEventListener("scroll", dispose, true);
  };
  const onOutside = (e: MouseEvent): void => {
    if (!popover.contains(e.target as Node)) dispose();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") dispose();
  };

  const addItem = (label: string, onSelect: () => void): void => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "pane-menu-item";
    item.textContent = label;
    item.addEventListener("click", () => {
      dispose();
      onSelect();
    });
    popover.append(item);
  };

  addItem(
    `Memory limit… (${opts.limitMb > 0 ? `${opts.limitMb} MB` : "off"})`,
    () => void promptMemoryLimit(opts),
  );
  addItem(
    `Idle auto-suspend… (${opts.idleMinutes > 0 ? `${opts.idleMinutes} min` : "off"})`,
    () => void promptIdleMinutes(opts),
  );

  document.body.append(popover);
  window.addEventListener("mousedown", onOutside, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", dispose);
  window.addEventListener("scroll", dispose, true);

  return { dispose };
}

async function promptMemoryLimit(opts: MemorySettingsMenuOptions): Promise<void> {
  const value = await promptModal({
    title: "Terminal memory limit",
    message:
      "In MB. Above this, terminals of background projects are auto-suspended (resumable). 0 = no limit (default).",
    placeholder: "e.g. 8192",
    initialValue: String(opts.limitMb),
    confirmLabel: "Set limit",
  });
  const parsed = parseNonNegative(value);
  if (parsed !== null) opts.onLimitChange(parsed);
}

async function promptIdleMinutes(opts: MemorySettingsMenuOptions): Promise<void> {
  const value = await promptModal({
    title: "Idle auto-suspend",
    message:
      "In minutes. Background AI terminals with no input or output for this long are auto-suspended (resumable). Shells are never touched. 0 = off (default).",
    placeholder: "e.g. 30",
    initialValue: String(opts.idleMinutes),
    confirmLabel: "Set threshold",
  });
  const parsed = parseNonNegative(value);
  if (parsed !== null) opts.onIdleChange(parsed);
}

function parseNonNegative(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    showToast("Value must be a number >= 0 (0 disables)", "error");
    return null;
  }
  return Math.round(parsed);
}
