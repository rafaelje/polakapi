export type BottomTab = "notes" | "shell";

export const BOTTOM_TABS: readonly BottomTab[] = ["notes", "shell"] as const;

export function isBottomTab(value: unknown): value is BottomTab {
  return value === "notes" || value === "shell";
}
