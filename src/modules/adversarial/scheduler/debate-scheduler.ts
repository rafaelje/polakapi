// Orchestrates the critic ↔ defender round loop.
//
// Contract:
//   - The scheduler owns the DebateState and writes state.json after every
//     transition. Memory is authoritative; disk is a mirror.
//   - Passes are executed sequentially — the debate depends on the previous
//     pass's arguments, so there is no fan-out to parallelize.
//   - Malformed JSON gets ONE retry with a "emit only the JSON" nudge. A
//     second failure marks the pass `error` and stops the run.
//   - Abort is cooperative: the running invoke() call returns whatever it has,
//     then the next pass sees `abortRequested` and short-circuits.

import { applyPass, finalizeLedger } from "../core/findings";
import { buildDebateInput } from "../core/debate-input";
import { parsePassOutput } from "../core/parse";
import { renderReport } from "../core/report";
import type { DebateSettings, DebateState, PassRecord, PassRole } from "../types";
import type { DebateInvokers } from "./invokers";
import { PersistenceQueue } from "./persistence";
import { DebateStore } from "./store";

const RETRY_NUDGE =
  "Your previous output failed to parse. Emit the SAME response ending with a single fenced ```json block matching the required schema — no prose after it.";

export interface DebateSchedulerDeps {
  invokers: DebateInvokers;
  now: () => number;
}

export class DebateScheduler {
  private readonly store: DebateStore;
  private readonly queue = new PersistenceQueue();
  private abortRequested = false;
  private runningPromise: Promise<DebateState> | null = null;

  constructor(
    initial: DebateState,
    private readonly deps: DebateSchedulerDeps,
  ) {
    this.store = new DebateStore(initial);
  }

  static seedState(settings: DebateSettings, _diff: string, diffTruncated: boolean): DebateState {
    return {
      status: "idle",
      settings,
      passes: seedPasses(settings.rounds),
      findings: { findings: [], appliedPasses: [] },
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      lastHeartbeat: 0,
      diffTruncated,
    };
  }

  getState(): DebateState {
    return this.store.get();
  }

  subscribe(listener: (state: DebateState) => void): () => void {
    return this.store.on(listener);
  }

  requestAbort(): void {
    this.abortRequested = true;
  }

  async start(diffContent: string): Promise<DebateState> {
    if (this.runningPromise) return this.runningPromise;
    this.runningPromise = this.runInternal(diffContent).finally(() => {
      this.runningPromise = null;
    });
    return this.runningPromise;
  }

  private async runInternal(diffContent: string): Promise<DebateState> {
    const { settings } = this.store.get();
    this.commit({ ...this.store.get(), status: "running", lastHeartbeat: this.deps.now() });

    for (let round = 1; round <= settings.rounds; round++) {
      // Critic pass — round 1 is find-mode, round 2+ is rebuttal. The reducer
      // enforces the rules; we just have to run the pass and hand it in.
      if (this.abortRequested) return this.finish("aborted");
      const criticState = await this.runPass(round, "critic", diffContent);
      if (criticState.status === "error") return criticState;

      // Optimization: skip defender pass if there are no in-play findings.
      // Happens when round-1 critic returns nothing or all findings are
      // already terminal (rare, but keeps the run from calling the model
      // pointlessly).
      const activeCount = criticState.findings.findings.filter(
        (f) => f.status === "open" || f.status === "challenged" || f.status === "contested",
      ).length;
      if (activeCount === 0) break;

      if (this.abortRequested) return this.finish("aborted");
      const defenderState = await this.runPass(round, "defender", diffContent);
      if (defenderState.status === "error") return defenderState;

      // Early exit: if nothing remains to argue about after this defender pass
      // (every finding terminal), skip further rounds — they'd be no-ops.
      const stillActive = defenderState.findings.findings.some(
        (f) => f.status === "open" || f.status === "challenged" || f.status === "contested",
      );
      if (!stillActive) break;
    }

    return this.finish("completed");
  }

  private async runPass(round: number, role: PassRole, diffContent: string): Promise<DebateState> {
    const state = this.store.get();
    const { settings } = state;
    const slot = role === "critic" ? settings.critic : settings.defender;

    // Update the pass record to `running` before the invoke.
    const passes = state.passes.map((p) =>
      p.round === round && p.role === role
        ? { ...p, status: "running" as const, startedAt: this.deps.now() }
        : p,
    );
    this.commit({ ...state, passes, lastHeartbeat: this.deps.now() });
    await this.persist();

    const promptName = role === "critic" ? "adversarial-critic.md" : "adversarial-defender.md";
    try {
      await this.deps.invokers.ensureRunPrompt(settings.projectPath, settings.runId, promptName);
    } catch (err) {
      return this.markPassError(round, role, `ensure prompt failed: ${asString(err)}`);
    }

    const promptPath = buildPromptPath(settings.projectPath, settings.runId, promptName);
    const input = buildDebateInput({
      round,
      role,
      rounds: settings.rounds,
      diff: diffContent,
      ledger: state.findings,
    });

    let retries = 0;
    let parseError = "unknown";
    let sessionUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.deps.invokers
        .runAgent({
          cli: slot.cli,
          model: slot.model,
          cwd: settings.projectPath,
          runId: settings.runId,
          systemPromptPath: promptPath,
          userInput: attempt === 0 ? input : `${input}\n\n---\n${RETRY_NUDGE}`,
          timeoutSecs: settings.timeoutSecs,
          effort: slot.effort === "default" ? null : slot.effort,
          runDirRoot: ".adversarial",
        })
        .catch((err) => ({
          text: "",
          tokensIn: null,
          tokensOut: null,
          costUsd: null,
          sessionId: null,
          error: asString(err),
        }));

      sessionUsage = accumulate(sessionUsage, result);
      const raw = result.text;
      if (result.error) {
        return this.markPassError(round, role, result.error, retries + attempt);
      }
      const parseRes = parsePassOutput(raw);
      if (parseRes.ok && parseRes.parsed.pass === role) {
        // Persist the raw output before applying to the ledger — the round-N
        // file is the ground truth for the report/UI.
        try {
          await this.deps.invokers.writeRunFile(
            settings.projectPath,
            settings.runId,
            `round-${round}-${role}.md`,
            raw,
          );
        } catch (err) {
          console.error("adversarial: failed to persist raw pass output", err);
        }
        const { ledger, warnings } = applyPass(state.findings, round, parseRes.parsed);
        for (const w of warnings) {
          console.warn(`adversarial: round ${round} ${role} — ${w.code}: ${w.message}`);
        }
        const passesDone = this.store.get().passes.map((p) =>
          p.round === round && p.role === role
            ? {
                ...p,
                status: "done" as const,
                tokensIn: p.tokensIn + sessionUsage.tokensIn,
                tokensOut: p.tokensOut + sessionUsage.tokensOut,
                costUsd: p.costUsd + sessionUsage.costUsd,
                retries: p.retries + retries + attempt,
                endedAt: this.deps.now(),
                message: warnings.length ? `${warnings.length} warning(s)` : undefined,
              }
            : p,
        );
        const totals = accumulateTotals(this.store.get().totals, sessionUsage);
        const next: DebateState = {
          ...this.store.get(),
          passes: passesDone,
          findings: ledger,
          totals,
          lastHeartbeat: this.deps.now(),
        };
        try {
          await this.deps.invokers.writeRunFile(
            settings.projectPath,
            settings.runId,
            "findings.json",
            JSON.stringify(ledger, null, 2),
          );
        } catch (err) {
          console.error("adversarial: failed to persist findings.json", err);
        }
        this.commit(next);
        await this.persist();
        return next;
      }
      parseError = parseRes.ok ? `pass field mismatch: ${parseRes.parsed.pass}` : parseRes.error;
      retries += 1;

      // Persist the failed output so post-mortem debugging doesn't lose it —
      // and update the pass record so the UI stops looking hung.
      try {
        await this.deps.invokers.writeRunFile(
          settings.projectPath,
          settings.runId,
          `round-${round}-${role}.md`,
          `<!-- parse failed on attempt ${attempt + 1}: ${parseError} -->\n\n${raw}`,
        );
      } catch (err) {
        console.error("adversarial: failed to persist raw pass output", err);
      }
      if (attempt === 0) {
        const passesRetrying = this.store.get().passes.map((p) =>
          p.round === round && p.role === role
            ? {
                ...p,
                message: `parse failed, retrying: ${parseError}`,
                retries: p.retries + 1,
              }
            : p,
        );
        this.commit({
          ...this.store.get(),
          passes: passesRetrying,
          lastHeartbeat: this.deps.now(),
        });
        await this.persist();
      }
    }

    return this.markPassError(
      round,
      role,
      `could not parse output after retry: ${parseError}. Raw output persisted at round-${round}-${role}.md for inspection.`,
      retries,
    );
  }

  private markPassError(round: number, role: PassRole, message: string, retries = 0): DebateState {
    const state = this.store.get();
    const passes = state.passes.map((p) =>
      p.round === round && p.role === role
        ? {
            ...p,
            status: "error" as const,
            retries: p.retries + retries,
            message,
            endedAt: this.deps.now(),
          }
        : p,
    );
    const next: DebateState = {
      ...state,
      status: "error",
      passes,
      lastHeartbeat: this.deps.now(),
    };
    this.commit(next);
    // Also emit report.md + findings.json on error — the on-screen report is
    // rendered from state either way, so the user should have the same file
    // on disk (labeled with whatever findings survived up to the failure).
    void this.writeReport(next);
    void this.deps.invokers
      .writeRunFile(
        state.settings.projectPath,
        state.settings.runId,
        "findings.json",
        JSON.stringify(next.findings, null, 2),
      )
      .catch((err) => console.error("adversarial: error-path findings.json write failed", err));
    void this.persist();
    return next;
  }

  private finish(status: "completed" | "aborted"): DebateState {
    const state = this.store.get();
    const findings = status === "completed" ? finalizeLedger(state.findings) : state.findings;
    const next: DebateState = {
      ...state,
      status,
      findings,
      lastHeartbeat: this.deps.now(),
    };
    this.commit(next);
    // Write the report and findings.json for BOTH completed and aborted runs —
    // the UI already renders the same report from in-memory state, so having
    // it on disk lets the user open/share it regardless of how the run ended.
    // Only `completed` runs get the `finalizeLedger` pass (turn lingering
    // findings into `disputed`).
    void this.writeReport(next);
    void this.deps.invokers
      .writeRunFile(
        state.settings.projectPath,
        state.settings.runId,
        "findings.json",
        JSON.stringify(findings, null, 2),
      )
      .catch((err) => console.error("adversarial: finalize write failed", err));
    void this.persist();
    return next;
  }

  private async writeReport(state: DebateState): Promise<void> {
    try {
      const report = renderReport(state);
      await this.deps.invokers.writeRunFile(
        state.settings.projectPath,
        state.settings.runId,
        "report.md",
        report,
      );
    } catch (err) {
      console.error("adversarial: report.md write failed", err);
    }
  }

  private commit(next: DebateState): void {
    this.store.commit(next);
  }

  private async persist(): Promise<void> {
    const snapshot = this.store.get();
    await this.queue.enqueue(async () => {
      await this.deps.invokers.writeState(
        snapshot.settings.projectPath,
        snapshot.settings.runId,
        JSON.stringify(snapshot, null, 2),
      );
    });
  }
}

function seedPasses(rounds: number): PassRecord[] {
  const passes: PassRecord[] = [];
  for (let round = 1; round <= rounds; round++) {
    passes.push(emptyPass(round, "critic"));
    passes.push(emptyPass(round, "defender"));
  }
  return passes;
}

function emptyPass(round: number, role: PassRole): PassRecord {
  return {
    round,
    role,
    status: "pending",
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    retries: 0,
  };
}

function accumulate(
  acc: { tokensIn: number; tokensOut: number; costUsd: number },
  result: { tokensIn: number | null; tokensOut: number | null; costUsd: number | null },
): { tokensIn: number; tokensOut: number; costUsd: number } {
  return {
    tokensIn: acc.tokensIn + (result.tokensIn ?? 0),
    tokensOut: acc.tokensOut + (result.tokensOut ?? 0),
    costUsd: acc.costUsd + (result.costUsd ?? 0),
  };
}

function accumulateTotals(
  totals: DebateState["totals"],
  delta: { tokensIn: number; tokensOut: number; costUsd: number },
): DebateState["totals"] {
  return {
    tokensIn: totals.tokensIn + delta.tokensIn,
    tokensOut: totals.tokensOut + delta.tokensOut,
    costUsd: totals.costUsd + delta.costUsd,
  };
}

function buildPromptPath(projectPath: string, runId: string, name: string): string {
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return [projectPath, ".adversarial", "runs", runId, "prompts", name].join(sep);
}

function asString(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
