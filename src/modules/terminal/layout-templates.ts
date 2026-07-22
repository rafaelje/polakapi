import { terminalLayoutPaneIds, type TerminalLayoutNode } from "./terminal-layout";
import type { TerminalSpec } from "./types";
import type { LayoutTemplate, LayoutTemplateSpec } from "../workspaces/state/types";

// ---------------------------------------------------------------------------
// Pure helpers for layout templates: capture (specs + tree → template) and
// application planning (template → reuse/spawn steps). No DOM, no I/O, so
// both are unit-testable without a TerminalManager.
// ---------------------------------------------------------------------------

/**
 * Builds a template from a manager's live specs and layout tree. Specs are
 * stored in layout order and stripped of `cwd` — templates are path-agnostic
 * and always spawn into the target project's path. Returns null when there is
 * nothing to capture (no name, no panes, or no layout).
 */
export function buildLayoutTemplate(
  name: string,
  specs: readonly TerminalSpec[],
  layout: TerminalLayoutNode | null,
): LayoutTemplate | null {
  const trimmed = name.trim();
  if (!trimmed || !layout) return null;
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const orderedIds = terminalLayoutPaneIds(layout).filter((id) => byId.has(id));
  if (orderedIds.length === 0) return null;
  const templateSpecs: LayoutTemplateSpec[] = orderedIds.map((id) => {
    const spec = byId.get(id) as TerminalSpec;
    return {
      id: spec.id,
      ...(spec.title ? { title: spec.title } : {}),
      ...(spec.startupCmd ? { startupCmd: spec.startupCmd } : {}),
      ...(spec.cliId ? { cliId: spec.cliId } : {}),
    };
  });
  return { id: crypto.randomUUID(), name: trimmed, specs: templateSpecs, layout };
}

export type TemplateApplyStep =
  | { specId: string; action: "reuse"; paneId: string }
  | { specId: string; action: "spawn"; spec: LayoutTemplateSpec };

/**
 * Runs a plan sequentially, building the template-spec-id → live-pane-id map
 * that repairTerminalLayout needs. `spawn` returns the new pane id, or null
 * when the spawn failed (that spec simply drops out of the map).
 */
export async function executeTemplatePlan(
  steps: readonly TemplateApplyStep[],
  spawn: (spec: LayoutTemplateSpec) => Promise<string | null>,
): Promise<Map<string, string>> {
  const idMap = new Map<string, string>();
  for (const step of steps) {
    if (step.action === "reuse") {
      idMap.set(step.specId, step.paneId);
      continue;
    }
    const spawnedId = await spawn(step.spec);
    if (spawnedId) idMap.set(step.specId, spawnedId);
  }
  return idMap;
}

/**
 * Decides, per template spec, whether an existing live pane can be reused
 * (same cliId, consumed first-come in current order) or a new pane must be
 * spawned. Live panes not consumed by any spec are left untouched — the
 * caller's repairTerminalLayout appends them after the template tree.
 */
export function planTemplateApplication(
  templateSpecs: readonly LayoutTemplateSpec[],
  livePanes: readonly { id: string; cliId?: string }[],
): TemplateApplyStep[] {
  const pool = new Map<string, string[]>();
  for (const pane of livePanes) {
    const key = pane.cliId ?? "shell";
    const ids = pool.get(key);
    if (ids) ids.push(pane.id);
    else pool.set(key, [pane.id]);
  }
  return templateSpecs.map((spec) => {
    const paneId = pool.get(spec.cliId ?? "shell")?.shift();
    return paneId
      ? { specId: spec.id, action: "reuse", paneId }
      : { specId: spec.id, action: "spawn", spec };
  });
}
