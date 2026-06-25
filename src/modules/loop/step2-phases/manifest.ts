// Pure manifest helpers extracted from step2-phases.ts: parse / serialize the
// `02-phases.md` manifest and normalize raw agent JSON into Phase / PhaseDraft.

import type { Phase } from "../step2-phases";

/**
 * Phase draft just returned by the agent — extends Phase with the initial
 * content of logic.md and, optionally, visual.html. We separate it from the
 * canonical Phase because the manifest (02-phases.md) does NOT persist the
 * content — that lives in logic.md / visual.html on disk.
 */
export interface PhaseDraft extends Phase {
  logic?: string;
  visual?: string;
}

/** Serializes the manifest as pretty-printed JSON inside a ```json fence. */
export function serializePhasesManifest(phases: Phase[]): string {
  const body = JSON.stringify({ phases }, null, 2);
  return `# Run phases\n\n\`\`\`json\n${body}\n\`\`\`\n`;
}

/**
 * Inverse parser of the manifest. Tolerant: extracts the first ```json fence
 * from the document, or parses the whole content if it looks like pure JSON.
 */
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

/**
 * Parses the step 2 agent's output. The prompt asks for strict JSON, but
 * some CLIs wrap it in fences or add preambles — we are tolerant. Returns
 * `PhaseDraft[]` with the extra `logic`/`visual` fields the agent produces.
 */
export function parseAgentPhasesJson(text: string): PhaseDraft[] {
  const cleaned = stripCodeFence(text.trim());
  try {
    const obj = JSON.parse(cleaned);
    let list: unknown[] | null = null;
    if (Array.isArray(obj)) {
      list = obj;
    } else if (obj && typeof obj === "object") {
      const maybe = (obj as { phases?: unknown }).phases;
      if (Array.isArray(maybe)) list = maybe;
    }
    if (!list) return [];
    return list.map((entry) => normalizePhaseDraft(entry)).filter((p): p is PhaseDraft => p !== null);
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

/** Strips a wrapping ```...``` fence if present; useful for LLM outputs. */
export function stripCodeFence(s: string): string {
  const m = s.match(/^```(?:[a-zA-Z]*)\n([\s\S]*?)\n```$/);
  return m ? m[1] : s;
}
