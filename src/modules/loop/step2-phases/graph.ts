// Pure graph helpers extracted from step2-phases.ts: slug derivation and
// cycle / topological-batch analysis over the phase dependency graph.

import type { Phase } from "../step2-phases";

// Type-only import above avoids a runtime cycle (step2-phases.ts re-exports
// these helpers). TS erases type imports, so this is safe at module load.

/**
 * Slug of a phase's directory: `<id>-<name>`. Matches the backend sanitizer
 * (`safe_run_id`): only [A-Za-z0-9_-]. The kebab-case name in the agent's
 * JSON already complies; we enforce it just in case.
 */
export function phaseSlug(phase: Phase): string {
  const safeName = phase.name.replace(/[^A-Za-z0-9_-]/g, "-");
  return `${phase.id}-${safeName}`;
}

export function slugToId(slug: string): string {
  const m = slug.match(/^(\d+)/);
  return m ? m[1] : slug;
}

/**
 * Detects a cycle in the dependency graph. Returns the cycle path (list of
 * ids) or null if there is none. Standard three-color DFS.
 */
export function detectCycle(phases: Phase[]): string[] | null {
  const byId = new Map(phases.map((p) => [p.id, p]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(phases.map((p) => [p.id, WHITE]));
  const parent = new Map<string, string | null>();
  let cycleStart: string | null = null;
  let cycleEnd: string | null = null;

  function dfs(u: string): boolean {
    color.set(u, GRAY);
    const phase = byId.get(u);
    if (!phase) {
      color.set(u, BLACK);
      return false;
    }
    for (const v of phase.dependsOn) {
      if (!byId.has(v)) continue; // dead reference — ignore it
      const c = color.get(v) ?? WHITE;
      if (c === WHITE) {
        parent.set(v, u);
        if (dfs(v)) return true;
      } else if (c === GRAY) {
        cycleStart = v;
        cycleEnd = u;
        return true;
      }
    }
    color.set(u, BLACK);
    return false;
  }

  for (const p of phases) {
    if ((color.get(p.id) ?? WHITE) === WHITE) {
      parent.set(p.id, null);
      if (dfs(p.id)) break;
    }
  }

  if (cycleStart === null || cycleEnd === null) return null;
  // Path reconstruction: from cycleEnd walking up via parent to cycleStart.
  const path: string[] = [cycleStart];
  let cur: string | null = cycleEnd;
  while (cur && cur !== cycleStart) {
    path.push(cur);
    cur = parent.get(cur) ?? null;
  }
  path.push(cycleStart);
  return path.reverse();
}

/**
 * Topological sort by levels (Kahn). Returns `Phase[][]` (each sub-array is
 * a batch of the hybrid mode). Returns null if there is a cycle.
 */
export function topologicalBatches(phases: Phase[]): Phase[][] | null {
  if (detectCycle(phases)) return null;
  const inDeg = new Map<string, number>();
  const byId = new Map(phases.map((p) => [p.id, p]));
  for (const p of phases) {
    // Only count deps that exist in the set (ignore dead references).
    const real = p.dependsOn.filter((d) => byId.has(d));
    inDeg.set(p.id, real.length);
  }
  const remaining = new Set(phases.map((p) => p.id));
  const batches: Phase[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => (inDeg.get(id) ?? 0) === 0);
    if (ready.length === 0) return null; // escaped cycle (defensive)
    const batch: Phase[] = [];
    for (const id of ready) {
      const p = byId.get(id);
      if (p) batch.push(p);
      remaining.delete(id);
    }
    // Subtract 1 from deps that pointed to the consumed nodes.
    for (const id of remaining) {
      const p = byId.get(id);
      if (!p) continue;
      const stillBlocking = p.dependsOn.filter((d) => remaining.has(d) && byId.has(d)).length;
      inDeg.set(id, stillBlocking);
    }
    batches.push(batch);
  }
  return batches;
}
