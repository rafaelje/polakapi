import type { Phase } from "./state";

/**
 * Agent's initial output — extends Phase with the initial content of
 * logic.md / visual.html. The manifest does not persist this content; it
 * lives on disk in the phase files.
 */
export interface PhaseDraft extends Phase {
  logic?: string;
  visual?: string;
}

export function serializePhasesManifest(phases: Phase[]): string {
  const body = JSON.stringify({ phases }, null, 2);
  return `# Run phases\n\n\`\`\`json\n${body}\n\`\`\`\n`;
}

export function parsePhasesManifest(content: string): Phase[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const fenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/);
  const body = fenceMatch ? fenceMatch[1] : trimmed;
  try {
    const obj: unknown = JSON.parse(body);
    let list: unknown[] | null = null;
    if (Array.isArray(obj)) {
      list = obj;
    } else if (obj && typeof obj === "object") {
      const maybe = (obj as { phases?: unknown }).phases;
      if (Array.isArray(maybe)) list = maybe;
    }
    if (!list) return [];
    return list.map((entry) => normalizePhase(entry)).filter((p): p is Phase => p !== null);
  } catch {
    return [];
  }
}

export function parseAgentPhasesJson(text: string): PhaseDraft[] {
  const cleaned = stripCodeFence(text.trim());
  try {
    const obj: unknown = JSON.parse(cleaned);
    let list: unknown[] | null = null;
    if (Array.isArray(obj)) {
      list = obj;
    } else if (obj && typeof obj === "object") {
      const maybe = (obj as { phases?: unknown }).phases;
      if (Array.isArray(maybe)) list = maybe;
    }
    if (!list) return [];
    return list
      .map((entry) => normalizePhaseDraft(entry))
      .filter((p): p is PhaseDraft => p !== null);
  } catch {
    return [];
  }
}

export function normalizePhase(raw: unknown): Phase | null {
  const draft = normalizePhaseDraft(raw);
  if (!draft) return null;
  return {
    id: draft.id,
    name: draft.name,
    summary: draft.summary,
    dependsOn: draft.dependsOn,
    hasVisual: draft.hasVisual,
  };
}

export function normalizePhaseDraft(raw: unknown): PhaseDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  const name = typeof r.name === "string" ? r.name : null;
  if (!id || !name) return null;
  const summary = typeof r.summary === "string" ? r.summary : "";
  const dependsOn = Array.isArray(r.dependsOn)
    ? r.dependsOn.filter((d): d is string => typeof d === "string")
    : [];
  const hasVisual = r.hasVisual === true;
  const logic = typeof r.logic === "string" ? r.logic : undefined;
  const visual = typeof r.visual === "string" ? r.visual : undefined;
  return { id, name, summary, dependsOn, hasVisual, logic, visual };
}

export function stripCodeFence(s: string): string {
  const m = s.match(/^```(?:[a-zA-Z]*)\n([\s\S]*?)\n```$/);
  return m ? m[1] : s;
}
