import type { ColorToken } from "./state/types";
import { PALETTE, deriveFallbackColor } from "./state/workspaces-reducer-appearance";

// ---------------------------------------------------------------------------
// F4 deterministic color default for rows that have not set an explicit
// color. Pure helper, no I/O. Used by both `workspace-row` and `project-row`
// so they agree on the fallback exactly, and by the breadcrumb to mirror the
// sidebar.
// ---------------------------------------------------------------------------

/** Re-export so callers can pull the deterministic color from one module. */
export function deterministicColor(id: string): ColorToken {
  return deriveFallbackColor(id);
}

export { PALETTE };
