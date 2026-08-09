// Reducer that folds a debate pass into the finding ledger.
//
// The state machine (see plan §2.2):
//
//   open ──(defender: concede)──────► confirmed
//   open ──(defender: refute)──► challenged ──(critic: withdraw)──► withdrawn
//                                challenged ──(critic: maintain)──► contested ──(next defender pass)──► ...
//   still challenged/contested at exhaustion ─────────────────────► disputed
//
// Rules:
//   - `new` findings are only allowed in round 1 by the critic.
//   - Terminal statuses (confirmed / withdrawn / disputed) are frozen.
//   - Silence is meaningful: a pass that omits a finding in play implicitly
//     concedes (defender's turn) or withdraws (critic's turn).
//   - Applying the same {round, role} pair twice is a no-op.

import type {
  DebateAction,
  Finding,
  FindingLedger,
  FindingStatus,
  PassRole,
  Severity,
} from "../types";
import type { ParsedFinding, ParsedPass } from "./parse";

const TERMINAL: FindingStatus[] = ["confirmed", "withdrawn", "disputed"];

function isTerminal(status: FindingStatus): boolean {
  return TERMINAL.includes(status);
}

export interface ReducerWarning {
  code:
    | "unknown-id"
    | "illegal-action"
    | "new-outside-round-1"
    | "new-missing-fields"
    | "duplicate-id"
    | "pass-already-applied";
  message: string;
  findingId?: string;
}

export interface ReducerResult {
  ledger: FindingLedger;
  warnings: ReducerWarning[];
}

export function createEmptyLedger(): FindingLedger {
  return { findings: [], appliedPasses: [] };
}

export function isPassApplied(ledger: FindingLedger, round: number, role: PassRole): boolean {
  return ledger.appliedPasses.some((p) => p.round === round && p.role === role);
}

export function nextFindingId(ledger: FindingLedger): string {
  const nums: number[] = [];
  for (const f of ledger.findings) {
    const m = /^F(\d+)$/.exec(f.id);
    if (m) nums.push(Number(m[1]));
  }
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `F${max + 1}`;
}

export interface ApplyPassOptions {
  // Ids of findings that were actually presented to the model in this pass.
  // The silence rule (implicit concede / withdraw) only fires for these.
  // If omitted, silence applies to every active finding (legacy behavior,
  // safe when the caller shows the whole ledger — e.g. tests).
  presentedIds?: ReadonlySet<string>;
}

// The core reducer. Never mutates its inputs.
export function applyPass(
  ledger: FindingLedger,
  round: number,
  parsed: ParsedPass,
  opts: ApplyPassOptions = {},
): ReducerResult {
  const warnings: ReducerWarning[] = [];
  if (isPassApplied(ledger, round, parsed.pass)) {
    return {
      ledger,
      warnings: [
        {
          code: "pass-already-applied",
          message: `round ${round} ${parsed.pass} pass already applied`,
        },
      ],
    };
  }

  // Deep clone so callers can persist the previous ledger safely.
  const findings = ledger.findings.map(cloneFinding);
  const seenIds = new Set(findings.map((f) => f.id));
  const touchedIds = new Set<string>();

  for (const entry of parsed.findings) {
    if (entry.action === "new") {
      if (parsed.pass !== "critic" || round !== 1) {
        warnings.push({
          code: "new-outside-round-1",
          message: `new findings only allowed in round 1 critic pass (${entry.id})`,
          findingId: entry.id,
        });
        continue;
      }
      if (!isCompleteNewFindingLocal(entry)) {
        warnings.push({
          code: "new-missing-fields",
          message: `missing file/severity/claim for new finding ${entry.id}`,
          findingId: entry.id,
        });
        continue;
      }
      if (seenIds.has(entry.id)) {
        warnings.push({
          code: "duplicate-id",
          message: `duplicate new finding id: ${entry.id}`,
          findingId: entry.id,
        });
        continue;
      }
      seenIds.add(entry.id);
      const created: Finding = {
        id: entry.id,
        file: entry.file as string,
        line: entry.line,
        severity: entry.severity as Severity,
        claim: entry.claim as string,
        status: "open",
        history: [
          {
            round,
            role: "critic",
            action: "new",
            argument: entry.argument,
          },
        ],
      };
      findings.push(created);
      touchedIds.add(entry.id);
      continue;
    }

    const target = findings.find((f) => f.id === entry.id);
    if (!target) {
      warnings.push({
        code: "unknown-id",
        message: `unknown finding id: ${entry.id}`,
        findingId: entry.id,
      });
      continue;
    }
    if (isTerminal(target.status)) {
      // Legal only if the pass would repeat an already-terminal decision; we
      // just skip — no warning, since the debate already left this finding.
      continue;
    }

    const legalActions = legalActionsFor(target.status, parsed.pass);
    if (!legalActions.includes(entry.action)) {
      warnings.push({
        code: "illegal-action",
        message: `illegal action ${entry.action} for finding ${entry.id} (${target.status}, ${parsed.pass})`,
        findingId: entry.id,
      });
      continue;
    }
    target.history.push({
      round,
      role: parsed.pass,
      action: entry.action,
      argument: entry.argument,
    });
    target.status = nextStatus(target.status, parsed.pass, entry.action);
    touchedIds.add(entry.id);
  }

  // Silence rule: for every non-terminal finding NOT addressed this pass,
  // record the implicit action defined in the state machine. Only applies
  // to findings the model actually saw — otherwise a ledger cap would
  // silently resolve every finding past the cap.
  for (const f of findings) {
    if (touchedIds.has(f.id)) continue;
    if (isTerminal(f.status)) continue;
    if (opts.presentedIds && !opts.presentedIds.has(f.id)) continue;

    if (parsed.pass === "defender") {
      const inPlay = f.status === "open" || f.status === "contested";
      if (!inPlay) continue;
      f.history.push({
        round,
        role: "defender",
        action: "concede",
        argument: IMPLICIT_ARGUMENT,
      });
      f.status = "confirmed";
    } else {
      const inPlay = f.status === "challenged";
      if (!inPlay) continue;
      f.history.push({
        round,
        role: "critic",
        action: "withdraw",
        argument: IMPLICIT_ARGUMENT,
      });
      f.status = "withdrawn";
    }
  }

  return {
    ledger: {
      findings,
      appliedPasses: [...ledger.appliedPasses, { round, role: parsed.pass }],
    },
    warnings,
  };
}

export const IMPLICIT_ARGUMENT = "(not addressed — implicit)";

// After the last round, any finding still non-terminal is `disputed`.
export function finalizeLedger(ledger: FindingLedger): FindingLedger {
  const findings: Finding[] = ledger.findings.map((f) =>
    isTerminal(f.status) ? f : { ...f, status: "disputed" },
  );
  return { ...ledger, findings };
}

function legalActionsFor(status: FindingStatus, role: PassRole): DebateAction[] {
  if (role === "defender") {
    // Defender passes act on findings the critic just introduced/maintained.
    if (status === "open" || status === "contested") {
      return ["concede", "refute", "dispute"];
    }
    return [];
  }
  // Critic follow-up passes only rebut challenged findings.
  if (status === "challenged") {
    return ["maintain", "withdraw"];
  }
  return [];
}

function nextStatus(status: FindingStatus, role: PassRole, action: DebateAction): FindingStatus {
  if (role === "defender") {
    if (action === "concede") return "confirmed";
    if (action === "refute") return "challenged";
    if (action === "dispute") return "challenged";
  } else if (role === "critic") {
    if (action === "withdraw") return "withdrawn";
    if (action === "maintain") return "contested";
  }
  return status;
}

function cloneFinding(f: Finding): Finding {
  return {
    ...f,
    history: f.history.map((h) => ({ ...h })),
  };
}

function isCompleteNewFindingLocal(f: ParsedFinding): boolean {
  return (
    typeof f.file === "string" &&
    f.file.length > 0 &&
    typeof f.severity === "string" &&
    typeof f.claim === "string" &&
    f.claim.length > 0
  );
}
