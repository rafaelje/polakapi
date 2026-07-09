import { describe, expect, it } from "vitest";

import {
  applyPass,
  createEmptyLedger,
  finalizeLedger,
  IMPLICIT_ARGUMENT,
  nextFindingId,
} from "./findings";
import type { ParsedPass } from "./parse";
import type { FindingLedger } from "../types";

function newFinding(id: string, extra: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    action: "new" as const,
    file: "src/foo.ts",
    line: 42,
    severity: "major" as const,
    claim: `finding ${id}`,
    argument: `evidence for ${id}`,
    ...extra,
  };
}

const criticR1 = (findings: unknown[]): ParsedPass => ({
  pass: "critic",
  findings: findings as ParsedPass["findings"],
});
const defenderR1 = (findings: unknown[]): ParsedPass => ({
  pass: "defender",
  findings: findings as ParsedPass["findings"],
});

describe("applyPass", () => {
  it("creates new findings only for round 1 critic pass", () => {
    const empty = createEmptyLedger();
    const { ledger, warnings } = applyPass(empty, 1, criticR1([newFinding("F1")]));
    expect(warnings).toHaveLength(0);
    expect(ledger.findings).toHaveLength(1);
    expect(ledger.findings[0].status).toBe("open");
    expect(ledger.appliedPasses).toEqual([{ round: 1, role: "critic" }]);
  });

  it("rejects new findings in round 2+", () => {
    const empty = createEmptyLedger();
    const { warnings, ledger } = applyPass(empty, 2, criticR1([newFinding("F1")]));
    expect(ledger.findings).toHaveLength(0);
    expect(warnings[0]?.code).toBe("new-outside-round-1");
  });

  it("rejects incomplete new findings", () => {
    const empty = createEmptyLedger();
    const { ledger, warnings } = applyPass(
      empty,
      1,
      criticR1([{ id: "F1", action: "new", argument: "no anchor" }]),
    );
    expect(ledger.findings).toHaveLength(0);
    expect(warnings[0]?.code).toBe("new-missing-fields");
  });

  it("defender concede confirms the finding", () => {
    let ledger: FindingLedger = createEmptyLedger();
    ledger = applyPass(ledger, 1, criticR1([newFinding("F1")])).ledger;
    ledger = applyPass(
      ledger,
      1,
      defenderR1([{ id: "F1", action: "concede", argument: "real bug" }]),
    ).ledger;
    expect(ledger.findings[0].status).toBe("confirmed");
  });

  it("defender refute → critic withdraw ends in withdrawn", () => {
    let ledger: FindingLedger = createEmptyLedger();
    ledger = applyPass(ledger, 1, criticR1([newFinding("F1")])).ledger;
    ledger = applyPass(
      ledger,
      1,
      defenderR1([{ id: "F1", action: "refute", argument: "false positive" }]),
    ).ledger;
    expect(ledger.findings[0].status).toBe("challenged");
    ledger = applyPass(
      ledger,
      2,
      criticR1([{ id: "F1", action: "withdraw", argument: "convinced" }]),
    ).ledger;
    expect(ledger.findings[0].status).toBe("withdrawn");
  });

  it("critic maintain → next defender refute keeps it contested/challenged", () => {
    let ledger: FindingLedger = createEmptyLedger();
    ledger = applyPass(ledger, 1, criticR1([newFinding("F1")])).ledger;
    ledger = applyPass(
      ledger,
      1,
      defenderR1([{ id: "F1", action: "refute", argument: "no" }]),
    ).ledger;
    ledger = applyPass(
      ledger,
      2,
      criticR1([{ id: "F1", action: "maintain", argument: "new evidence" }]),
    ).ledger;
    expect(ledger.findings[0].status).toBe("contested");
  });

  it("implicitly concedes findings the defender ignores", () => {
    let ledger: FindingLedger = createEmptyLedger();
    ledger = applyPass(ledger, 1, criticR1([newFinding("F1"), newFinding("F2")])).ledger;
    ledger = applyPass(
      ledger,
      1,
      defenderR1([{ id: "F1", action: "refute", argument: "no" }]),
    ).ledger;
    expect(ledger.findings.find((f) => f.id === "F2")?.status).toBe("confirmed");
    const impl = ledger.findings
      .find((f) => f.id === "F2")
      ?.history.find((h) => h.argument === IMPLICIT_ARGUMENT);
    expect(impl?.action).toBe("concede");
  });

  it("implicitly withdraws challenged findings the critic ignores", () => {
    let ledger: FindingLedger = createEmptyLedger();
    ledger = applyPass(ledger, 1, criticR1([newFinding("F1")])).ledger;
    ledger = applyPass(
      ledger,
      1,
      defenderR1([{ id: "F1", action: "refute", argument: "no" }]),
    ).ledger;
    // Round 2 critic pass with F1 missing → implicit withdraw.
    ledger = applyPass(ledger, 2, criticR1([])).ledger;
    expect(ledger.findings[0].status).toBe("withdrawn");
  });

  it("finalize turns lingering non-terminal findings into disputed", () => {
    let ledger: FindingLedger = createEmptyLedger();
    ledger = applyPass(ledger, 1, criticR1([newFinding("F1")])).ledger;
    ledger = applyPass(
      ledger,
      1,
      defenderR1([{ id: "F1", action: "refute", argument: "no" }]),
    ).ledger;
    ledger = applyPass(
      ledger,
      2,
      criticR1([{ id: "F1", action: "maintain", argument: "yes" }]),
    ).ledger;
    ledger = applyPass(
      ledger,
      2,
      defenderR1([{ id: "F1", action: "dispute", argument: "severity is wrong" }]),
    ).ledger;
    const finalized = finalizeLedger(ledger);
    expect(finalized.findings[0].status).toBe("disputed");
  });

  it("is idempotent when re-applying an already-applied pass", () => {
    let ledger: FindingLedger = createEmptyLedger();
    ledger = applyPass(ledger, 1, criticR1([newFinding("F1")])).ledger;
    const { ledger: again, warnings } = applyPass(ledger, 1, criticR1([newFinding("F2")]));
    expect(again.findings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("pass-already-applied");
  });

  it("nextFindingId walks past existing gaps", () => {
    const ledger: FindingLedger = createEmptyLedger();
    const next = applyPass(ledger, 1, criticR1([newFinding("F1"), newFinding("F5")])).ledger;
    expect(nextFindingId(next)).toBe("F6");
  });

  it("rejects illegal actions from the wrong role", () => {
    let ledger: FindingLedger = createEmptyLedger();
    ledger = applyPass(ledger, 1, criticR1([newFinding("F1")])).ledger;
    // Critic emits `concede`, which is defender territory.
    const { warnings } = applyPass(
      ledger,
      2,
      criticR1([{ id: "F1", action: "concede", argument: "should not work" }]),
    );
    expect(warnings[0]?.code).toBe("illegal-action");
  });
});
