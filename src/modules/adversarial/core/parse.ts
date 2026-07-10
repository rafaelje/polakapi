// Extract the structured JSON block emitted by each debate pass.
//
// Agents echo the example format in prose; we always take the LAST fenced
// ```json block as the authoritative answer (same lesson learned by
// `parseReviewVerdict` in /loop).

import type { DebateAction, PassRole, Severity } from "../types";

export interface ParsedPass {
  pass: PassRole;
  findings: ParsedFinding[];
}

// After parsing we do not yet know if `action=new` fields are complete —
// [`validateForPass`] enforces that.
export interface ParsedFinding {
  id: string;
  action: DebateAction;
  argument: string;
  // Only used for `action=new`.
  file?: string;
  line?: number;
  severity?: Severity;
  claim?: string;
}

export interface ParseSuccess {
  ok: true;
  parsed: ParsedPass;
}

export interface ParseFailure {
  ok: false;
  error: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

const VALID_ACTIONS = new Set<DebateAction>([
  "new",
  "maintain",
  "withdraw",
  "refute",
  "concede",
  "dispute",
]);
const VALID_SEVERITIES = new Set<Severity>(["critical", "major", "minor", "nit"]);
const VALID_ROLES = new Set<PassRole>(["critic", "defender"]);
// Case-insensitive ```json fence, tolerant of an optional space between the
// backticks and the tag (```json / ``` json / ```JSON).
const FENCE_REGEX = /```\s*json\s*([\s\S]*?)```/gi;
const MAX_ARGUMENT_LEN = 4000;

// Extract the LAST fenced ```json block. Falls back to a raw JSON object
// scan if there are no fences (some agents skip them).
function extractLastJsonBlock(raw: string): string | null {
  let last: string | null = null;
  for (const m of raw.matchAll(FENCE_REGEX)) {
    const body = m[1]?.trim();
    if (body) last = body;
  }
  if (last !== null) return last;

  // Fallback: scan for a bare `{ ... }` object with balanced braces starting
  // at the last `{"pass"` occurrence. This is a heuristic, but it saves us a
  // retry when the model forgets the fence.
  const anchor = raw.lastIndexOf('"pass"');
  if (anchor === -1) return null;
  const start = raw.lastIndexOf("{", anchor);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parsePassOutput(raw: string): ParseResult {
  const block = extractLastJsonBlock(raw);
  if (block === null) {
    return { ok: false, error: "no JSON block found" };
  }

  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch (err) {
    return {
      ok: false,
      error: `malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "JSON root is not an object" };
  }
  const rec = value as Record<string, unknown>;
  const pass = rec.pass;
  if (typeof pass !== "string" || !VALID_ROLES.has(pass as PassRole)) {
    return { ok: false, error: `invalid pass field: ${String(pass)}` };
  }
  const findingsRaw = rec.findings;
  if (!Array.isArray(findingsRaw)) {
    return { ok: false, error: "findings is not an array" };
  }

  const findings: ParsedFinding[] = [];
  for (const entry of findingsRaw) {
    if (typeof entry !== "object" || entry === null) continue;
    const f = entry as Record<string, unknown>;
    const id = typeof f.id === "string" ? f.id.trim() : "";
    const rawAction = typeof f.action === "string" ? f.action.trim() : "";
    if (!id) continue;

    const argument = typeof f.argument === "string" ? f.argument.slice(0, MAX_ARGUMENT_LEN) : "";
    const file = typeof f.file === "string" ? f.file : undefined;
    const line = typeof f.line === "number" && Number.isFinite(f.line) ? f.line : undefined;
    const severity =
      typeof f.severity === "string" && VALID_SEVERITIES.has(f.severity as Severity)
        ? (f.severity as Severity)
        : undefined;
    const claim = typeof f.claim === "string" ? f.claim.trim() : undefined;

    let action: DebateAction;
    if (VALID_ACTIONS.has(rawAction as DebateAction)) {
      action = rawAction as DebateAction;
    } else if (
      pass === "critic" &&
      file !== undefined &&
      severity !== undefined &&
      claim !== undefined &&
      claim.length > 0
    ) {
      // Infer `action: "new"` when a critic finding has the anchor fields but
      // the model forgot the discriminator. Real-world models (GLM, small
      // Sonnets) omit `action` even when the prompt requires it; dropping
      // otherwise-well-formed findings is much worse than accepting the
      // implied "new".
      action = "new";
    } else {
      continue;
    }

    findings.push({
      id,
      action,
      argument,
      file,
      line,
      severity,
      claim,
    });
  }

  return {
    ok: true,
    parsed: { pass: pass as PassRole, findings },
  };
}

// A `new` finding requires the anchor fields; everything else only needs
// id + action + argument.
export function isCompleteNewFinding(f: ParsedFinding): boolean {
  return (
    f.action === "new" &&
    typeof f.file === "string" &&
    f.file.length > 0 &&
    typeof f.severity === "string" &&
    typeof f.claim === "string" &&
    f.claim.length > 0
  );
}
