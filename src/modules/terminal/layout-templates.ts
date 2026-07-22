import { terminalLayoutPaneIds, type TerminalLayoutNode } from "./terminal-layout";
import type { TerminalSpec } from "./types";
import type { LayoutTemplate, LayoutTemplateSpec } from "../workspaces/state/types";

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
