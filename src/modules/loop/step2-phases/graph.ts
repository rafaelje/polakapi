import type { Phase } from "./state";

/**
 * Slug of a phase's directory: `<id>-<name>`. Must match the backend
 * sanitizer (`safe_run_id`): only [A-Za-z0-9_-].
 */
export function phaseSlug(phase: Phase): string {
  const safeName = phase.name.replace(/[^A-Za-z0-9_-]/g, "-");
  return `${phase.id}-${safeName}`;
}

export function slugToId(slug: string): string {
  const m = slug.match(/^(\d+)/);
  return m ? m[1] : slug;
}

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
      if (!byId.has(v)) continue;
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
  const path: string[] = [cycleStart];
  let cur: string | null = cycleEnd;
  while (cur && cur !== cycleStart) {
    path.push(cur);
    cur = parent.get(cur) ?? null;
  }
  path.push(cycleStart);
  return path.reverse();
}

export function topologicalBatches(phases: Phase[]): Phase[][] | null {
  if (detectCycle(phases)) return null;
  const inDeg = new Map<string, number>();
  const byId = new Map(phases.map((p) => [p.id, p]));
  for (const p of phases) {
    const real = p.dependsOn.filter((d) => byId.has(d));
    inDeg.set(p.id, real.length);
  }
  const remaining = new Set(phases.map((p) => p.id));
  const batches: Phase[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => (inDeg.get(id) ?? 0) === 0);
    if (ready.length === 0) return null;
    const batch: Phase[] = [];
    for (const id of ready) {
      const p = byId.get(id);
      if (p) batch.push(p);
      remaining.delete(id);
    }
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
