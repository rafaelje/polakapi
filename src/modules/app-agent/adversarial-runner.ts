import { stringifyError } from "../../shared/errors";
import { DebateScheduler } from "../adversarial/scheduler/debate-scheduler";
import { invokers } from "../adversarial/scheduler/invokers";
import {
  DEFAULT_BLOCKING,
  DEFAULT_ROUNDS,
  DEFAULT_TIMEOUT_SECS,
  MAX_ROUNDS,
  MIN_ROUNDS,
  defaultModelForCli,
  type DebateSettings,
  type DebateSlot,
  type DebateState,
  type DiffMode,
  type Severity,
} from "../adversarial/types";
import { LOOP_CLIS, type LoopCli } from "../loop/types";

// Headless counterpart of the /adversarial review window: same scheduler, same
// run directory layout (`<project>/.adversarial/runs/<runId>/`), but started
// by the operator agent and polled through state.json instead of a view. The
// window can open the same run afterwards because nothing here is private.

export interface AdversarialStartInput {
  projectPath: string;
  rounds?: number;
  critic?: Partial<DebateSlot>;
  defender?: Partial<DebateSlot>;
  diffMode?: DiffMode;
  baseRef?: string;
  scopePaths?: string[];
  blockingSeverity?: Severity;
  timeoutSecs?: number;
}

export interface AdversarialStartResult {
  runId: string;
  baseRef: string;
  headSha: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  diffTruncated: boolean;
}

interface RunHandle {
  projectPath: string;
  scheduler: DebateScheduler;
  startedAt: number;
  crash: string | null;
}

export class AdversarialRunnerError extends Error {}

function resolveSlot(partial: Partial<DebateSlot> | undefined, fallback: DebateSlot): DebateSlot {
  const cli = partial?.cli ?? fallback.cli;
  if (!LOOP_CLIS.includes(cli)) {
    throw new AdversarialRunnerError(`cli must be one of: ${LOOP_CLIS.join(", ")}`);
  }
  return {
    cli,
    model: partial?.model ?? (partial?.cli ? defaultModelForCli(cli) : fallback.model),
    effort: partial?.effort ?? fallback.effort,
  };
}

export class AdversarialRunner {
  private readonly runs = new Map<string, RunHandle>();

  async start(input: AdversarialStartInput): Promise<AdversarialStartResult> {
    const rounds = input.rounds ?? DEFAULT_ROUNDS;
    if (rounds < MIN_ROUNDS || rounds > MAX_ROUNDS) {
      throw new AdversarialRunnerError(`rounds must be between ${MIN_ROUNDS} and ${MAX_ROUNDS}`);
    }
    const critic = resolveSlot(input.critic, {
      cli: "claude",
      model: defaultModelForCli("claude"),
      effort: "default",
    });
    const defender = resolveSlot(input.defender, {
      cli: "codex",
      model: defaultModelForCli("codex"),
      effort: "high",
    });
    await this.validate("critic", critic);
    await this.validate("defender", defender);

    const diffMode = input.diffMode ?? "committed";
    let baseRef = input.baseRef?.trim() ?? "";
    if (!baseRef && diffMode === "committed") {
      try {
        baseRef = await invokers.detectBaseRef(input.projectPath);
      } catch (error) {
        throw new AdversarialRunnerError(`could not detect base branch: ${stringifyError(error)}`);
      }
    }
    let diff;
    try {
      diff = await invokers.branchDiff(
        input.projectPath,
        baseRef || "HEAD",
        input.scopePaths ?? [],
        diffMode,
      );
    } catch (error) {
      throw new AdversarialRunnerError(`could not compute the diff: ${stringifyError(error)}`);
    }
    if (diff.filesChanged === 0 || !diff.diff.trim()) {
      throw new AdversarialRunnerError("the diff is empty; nothing to review");
    }

    const runId = crypto.randomUUID();
    const settings: DebateSettings = {
      projectPath: input.projectPath,
      runId,
      baseRef: diff.baseRef,
      mergeBase: diff.mergeBase,
      headSha: diff.headSha,
      rounds,
      critic,
      defender,
      blockingSeverity: input.blockingSeverity ?? DEFAULT_BLOCKING,
      timeoutSecs: input.timeoutSecs ?? DEFAULT_TIMEOUT_SECS,
      scopePaths: diff.paths,
      diffMode: diff.mode,
    };
    try {
      await invokers.createRun(input.projectPath, runId);
      await invokers.writeRunFile(input.projectPath, runId, "diff.patch", diff.diff);
    } catch (error) {
      throw new AdversarialRunnerError(`could not initialize the run: ${stringifyError(error)}`);
    }

    const initial = DebateScheduler.seedState(settings, diff.diff, {
      truncated: diff.truncated,
      filesExcluded: diff.filesExcluded,
      filesTruncated: diff.filesTruncated,
    });
    const scheduler = new DebateScheduler(initial, { invokers, now: () => Date.now() });
    const handle: RunHandle = {
      projectPath: input.projectPath,
      scheduler,
      startedAt: Date.now(),
      crash: null,
    };
    this.runs.set(runId, handle);
    void scheduler.start(diff.diff).catch((error) => {
      handle.crash = stringifyError(error);
      console.error("app-agent: adversarial run crashed", error);
    });

    return {
      runId,
      baseRef: diff.baseRef,
      headSha: diff.headSha,
      filesChanged: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
      diffTruncated: diff.truncated,
    };
  }

  /** Live state for runs started here; falls back to state.json on disk. */
  async state(projectPath: string, runId: string): Promise<DebateState | null> {
    const handle = this.runs.get(runId);
    if (handle) {
      const state = handle.scheduler.getState();
      if (handle.crash && state.status === "running") {
        return { ...state, status: "error" };
      }
      return state;
    }
    try {
      const raw = await invokers.readState(projectPath, runId);
      return JSON.parse(raw) as DebateState;
    } catch {
      return null;
    }
  }

  crashReason(runId: string): string | null {
    return this.runs.get(runId)?.crash ?? null;
  }

  abort(runId: string): boolean {
    const handle = this.runs.get(runId);
    if (!handle) return false;
    handle.scheduler.requestAbort();
    return true;
  }

  private async validate(role: string, slot: DebateSlot): Promise<void> {
    const result = await invokers.validateCli(slot);
    if (!result.ok) {
      throw new AdversarialRunnerError(
        `${role} ${slot.cli}/${slot.model} is not usable: ${result.reason ?? "unknown reason"}`,
      );
    }
  }
}

export function isLoopCli(value: string): value is LoopCli {
  return (LOOP_CLIS as readonly string[]).includes(value);
}
