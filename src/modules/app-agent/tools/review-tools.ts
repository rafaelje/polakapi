import type { DebateState, Effort, Severity } from "../../adversarial/types";
import { AdversarialRunnerError, isLoopCli } from "../adversarial-runner";
import {
  oneOf,
  optionalInteger,
  optionalString,
  optionalStringArray,
  requiredString,
} from "./args";
import { resolveProject } from "./resolve";
import { requireController, ToolError, type ToolArgs, type ToolDef } from "./types";

// Adversarial review: a critic and a defender CLI debate a branch diff for a
// few rounds. Start it, poll it, read the ledger.

const EFFORTS: readonly Effort[] = ["default", "low", "medium", "high", "xhigh"];
const SEVERITIES: readonly Severity[] = ["critical", "major", "minor", "nit"];

const PROJECT_ARG = {
  type: "string",
  description: "Project id, unique name or absolute path. Defaults to the active project.",
};

function slotArg(role: string) {
  return {
    type: "object",
    description: `${role} agent. Defaults: critic claude/claude-opus-4-7, defender codex/gpt-5.5 (effort high).`,
    properties: {
      cli: { type: "string", enum: ["claude", "codex", "opencode"] },
      model: { type: "string" },
      effort: { type: "string", enum: EFFORTS },
    },
    additionalProperties: false,
  };
}

function readSlot(args: ToolArgs, key: string) {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new ToolError(`"${key}" must be an object`);
  const slot = raw as ToolArgs;
  const cli = optionalString(slot, "cli");
  if (cli !== undefined && !isLoopCli(cli)) {
    throw new ToolError(`"${key}.cli" must be claude, codex or opencode`);
  }
  return {
    cli,
    model: optionalString(slot, "model"),
    effort: oneOf(slot, "effort", EFFORTS),
  };
}

function summarize(state: DebateState, crash: string | null) {
  const done = state.passes.filter((pass) => pass.status === "done").length;
  const running = state.passes.find((pass) => pass.status === "running");
  const counts: Record<string, number> = {};
  for (const finding of state.findings.findings) {
    counts[finding.status] = (counts[finding.status] ?? 0) + 1;
  }
  return {
    status: state.status,
    crash,
    rounds: state.settings.rounds,
    passesDone: done,
    passesTotal: state.passes.length,
    currentPass: running ? { round: running.round, role: running.role } : null,
    findingsByStatus: counts,
    totals: state.totals,
    diffTruncated: state.diffTruncated,
    settings: {
      baseRef: state.settings.baseRef,
      headSha: state.settings.headSha,
      diffMode: state.settings.diffMode,
      critic: state.settings.critic,
      defender: state.settings.defender,
      blockingSeverity: state.settings.blockingSeverity,
    },
  };
}

export const reviewTools: ToolDef[] = [
  {
    name: "polakapi_adversarial_start",
    description:
      "Start an adversarial review of a project's branch: a critic agent reports findings on the diff and a defender agent challenges them over N rounds. Returns a runId to poll with polakapi_adversarial_status. The run writes to <project>/.adversarial/runs/<runId>/.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_ARG,
        rounds: { type: "integer", description: "1 to 3. Default 2." },
        diffMode: {
          type: "string",
          enum: ["committed", "working"],
          description: "committed = base branch…HEAD (default); working = uncommitted changes.",
        },
        baseRef: { type: "string", description: "Base branch. Auto-detected when omitted." },
        scopePaths: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths to limit the diff to.",
        },
        blockingSeverity: { type: "string", enum: SEVERITIES },
        timeoutSecs: { type: "integer", description: "Per-pass timeout. Default 600." },
        critic: slotArg("Critic"),
        defender: slotArg("Defender"),
      },
    },
    run: async (args, ctx) => {
      const { project } = resolveProject(requireController(ctx).getState(), args);
      if (project.pathInvalid) throw new ToolError(`project "${project.name}" has an invalid path`);
      try {
        const result = await ctx.adversarial.start({
          projectPath: project.path,
          rounds: optionalInteger(args, "rounds", { min: 1, max: 3 }),
          diffMode: oneOf(args, "diffMode", ["committed", "working"] as const),
          baseRef: optionalString(args, "baseRef"),
          scopePaths: optionalStringArray(args, "scopePaths"),
          blockingSeverity: oneOf(args, "blockingSeverity", SEVERITIES),
          timeoutSecs: optionalInteger(args, "timeoutSecs", { min: 30, max: 7200 }),
          critic: readSlot(args, "critic"),
          defender: readSlot(args, "defender"),
        });
        return { project: { id: project.id, name: project.name }, ...result };
      } catch (error) {
        if (error instanceof AdversarialRunnerError) throw new ToolError(error.message);
        throw error;
      }
    },
  },
  {
    name: "polakapi_adversarial_status",
    description:
      "Progress of an adversarial review: status, passes done, current pass, findings by status and token totals. Works for runs started here or earlier from the window.",
    inputSchema: {
      type: "object",
      properties: { project: PROJECT_ARG, runId: { type: "string" } },
      required: ["runId"],
    },
    run: async (args, ctx) => {
      const { project } = resolveProject(requireController(ctx).getState(), args);
      const runId = requiredString(args, "runId");
      const state = await ctx.adversarial.state(project.path, runId);
      if (!state) throw new ToolError(`no run "${runId}" in ${project.name}`);
      return { runId, ...summarize(state, ctx.adversarial.crashReason(runId)) };
    },
  },
  {
    name: "polakapi_adversarial_findings",
    description:
      "Findings of an adversarial review with file, line, severity, status and the argument history of each.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_ARG,
        runId: { type: "string" },
        status: {
          type: "string",
          enum: ["open", "challenged", "contested", "confirmed", "withdrawn", "disputed"],
          description: "Only findings in this status.",
        },
      },
      required: ["runId"],
    },
    run: async (args, ctx) => {
      const { project } = resolveProject(requireController(ctx).getState(), args);
      const runId = requiredString(args, "runId");
      const state = await ctx.adversarial.state(project.path, runId);
      if (!state) throw new ToolError(`no run "${runId}" in ${project.name}`);
      const status = optionalString(args, "status");
      return {
        runId,
        status: state.status,
        findings: state.findings.findings
          .filter((finding) => !status || finding.status === status)
          .map((finding) => ({
            id: finding.id,
            file: finding.file,
            line: finding.line ?? null,
            severity: finding.severity,
            status: finding.status,
            claim: finding.claim,
            history: finding.history.map((event) => ({
              round: event.round,
              role: event.role,
              action: event.action,
              argument: event.argument,
            })),
          })),
      };
    },
  },
  {
    name: "polakapi_adversarial_abort",
    description: "Stop an adversarial review started in this session after its current pass.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
    run: (args, ctx) => {
      const runId = requiredString(args, "runId");
      if (!ctx.adversarial.abort(runId)) {
        throw new ToolError(`run "${runId}" is not running in this session`);
      }
      return { runId, aborting: true };
    },
  },
];
