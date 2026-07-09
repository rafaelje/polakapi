// Builds the user-input string for each debate pass.
//
// The critic in round 1 gets the diff only. Every subsequent pass also
// receives the current ledger (JSON) and the opposing side's latest arguments
// so the model can rebut precisely.

import type { Finding, FindingLedger, PassRole } from "../types";

export interface DebateInputArgs {
  round: number;
  role: PassRole;
  rounds: number;
  diff: string;
  ledger: FindingLedger;
  // Findings-per-turn cap so we don't blow up the input on runaway pass counts.
  // 30 kept as the pragmatic ceiling — critical work rarely needs more.
  maxFindingsInLedger?: number;
}

const DEFAULT_MAX = 30;

export function buildDebateInput(args: DebateInputArgs): string {
  const { round, role, rounds, diff, ledger } = args;
  const cap = args.maxFindingsInLedger ?? DEFAULT_MAX;

  const parts: string[] = [];
  parts.push(`MODE: ${role === "critic" ? (round === 1 ? "find" : "rebuttal") : "defend"}`);
  parts.push(`ROUND: ${round} of ${rounds}`);
  parts.push("");

  // Diff first — models read top-first; we want the anchor near the top.
  parts.push("## Diff (branch-vs-base)");
  parts.push("```diff");
  parts.push(diff.trimEnd());
  parts.push("```");

  if (!(round === 1 && role === "critic")) {
    parts.push("");
    parts.push("## Findings ledger (JSON — do not modify existing ids)");
    parts.push("```json");
    parts.push(JSON.stringify(summarizeLedger(ledger, cap), null, 2));
    parts.push("```");
    parts.push("");
    parts.push(`## Your turn (${role}, round ${round})`);
    if (role === "critic") {
      parts.push(
        "Rebut every finding the defender challenged. Use `maintain` only with NEW evidence beyond your round-1 argument; otherwise `withdraw`. Do NOT introduce new findings — the ledger is closed after round 1.",
      );
    } else {
      parts.push(
        "For every open/contested finding: `concede` (real defect), `refute` (false positive with evidence) or `dispute` (arguing severity/scope, not existence). Silence counts as `concede`.",
      );
    }
  } else {
    parts.push("");
    parts.push("## Your turn (critic, round 1)");
    parts.push(
      "Emit every defect you find with a stable id (F1, F2, …), file, line if precise, severity (critical|major|minor|nit) and a one-sentence claim + evidence anchored in the diff.",
    );
  }

  parts.push("");
  parts.push("## Required output");
  parts.push("End your response with a single fenced ```json block:");
  parts.push("```json");
  parts.push(exampleFor(role, round));
  parts.push("```");

  return parts.join("\n");
}

function exampleFor(role: PassRole, round: number): string {
  if (role === "critic" && round === 1) {
    return JSON.stringify(
      {
        pass: "critic",
        findings: [
          {
            id: "F1",
            action: "new",
            file: "src/foo.ts",
            line: 42,
            severity: "major",
            claim: "off-by-one in the loop bound",
            argument: "…evidence…",
          },
        ],
      },
      null,
      2,
    );
  }
  if (role === "critic") {
    return JSON.stringify(
      {
        pass: "critic",
        findings: [{ id: "F1", action: "maintain", argument: "…new evidence…" }],
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      pass: "defender",
      findings: [{ id: "F1", action: "concede", argument: "yes, this is a real bug" }],
    },
    null,
    2,
  );
}

// Trim the ledger to the fields the model needs, capped to avoid blowing up
// on huge ledgers. Terminal findings are excluded — nothing to argue about.
function summarizeLedger(
  ledger: FindingLedger,
  cap: number,
): Array<
  Pick<Finding, "id" | "file" | "line" | "severity" | "claim" | "status"> & {
    lastArgument?: string;
    lastRole?: string;
  }
> {
  const active = ledger.findings.filter(
    (f) => f.status !== "confirmed" && f.status !== "withdrawn" && f.status !== "disputed",
  );
  return active.slice(0, cap).map((f) => {
    const last = f.history[f.history.length - 1];
    return {
      id: f.id,
      file: f.file,
      line: f.line,
      severity: f.severity,
      claim: f.claim,
      status: f.status,
      lastArgument: last?.argument,
      lastRole: last?.role,
    };
  });
}
