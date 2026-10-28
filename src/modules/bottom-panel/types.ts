export type BottomTab = "notes" | "shell" | "agent" | "usage";

export const BOTTOM_TABS: readonly BottomTab[] = ["notes", "shell", "agent", "usage"] as const;

export function isBottomTab(value: unknown): value is BottomTab {
  return (BOTTOM_TABS as readonly unknown[]).includes(value);
}
