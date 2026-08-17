export type BottomTab = "notes" | "shell" | "usage";

export const BOTTOM_TABS: readonly BottomTab[] = ["notes", "shell", "usage"] as const;

export function isBottomTab(value: unknown): value is BottomTab {
  return value === "notes" || value === "shell" || value === "usage";
}
