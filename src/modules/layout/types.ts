export type SidebarTarget = "sidebar-left" | "sidebar-right";

export interface ToggleBinding {
  btnId: string;
  target: HTMLElement;
  cls: string;
}
