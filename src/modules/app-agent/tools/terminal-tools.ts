import { invoke } from "../../../shared/tauri/invoke";
import { bracketedPaste } from "../../agents-library/compose";
import type { AgentSummary } from "../../agent-context/types";
import { AI_CLI_PROFILES } from "../../terminal/cli-registry";
import { ptyWrite } from "../../terminal/pty-client";
import type { TerminalManager } from "../../terminal/terminal-manager";
import type { Project } from "../../workspaces/state/types";
import { optionalBoolean, optionalInteger, optionalString, requiredString } from "./args";
import { findProjectByRef, resolveProject } from "./resolve";
import { requireController, ToolError, type ToolContext, type ToolDef } from "./types";

// Terminal panes: what runs where, and the two write paths the operator has
// (open a pane, paste into a pane).

interface RunningPane {
  ptyId: string;
  command: string;
}

async function runningCommands(): Promise<Map<string, string>> {
  try {
    const rows = await invoke<RunningPane[]>("pty_running_commands", {}, { toastOnError: false });
    return new Map(rows.map((row) => [row.ptyId, row.command]));
  } catch {
    return new Map();
  }
}

async function agentSummaries(): Promise<Map<string, AgentSummary>> {
  try {
    const rows = await invoke<AgentSummary[]>("agent_context_list", {}, { toastOnError: false });
    return new Map(rows.map((row) => [row.ptyId, row]));
  } catch {
    return new Map();
  }
}

function terminalRows(
  project: Project,
  manager: TerminalManager | null,
  running: Map<string, string>,
  agents: Map<string, AgentSummary>,
) {
  const specs = manager?.specs() ?? project.terminals ?? [];
  return specs.map((spec, index) => {
    const live = manager?.isLive(spec.id) ?? false;
    const pane = manager?.get(spec.id);
    const agent = agents.get(spec.id);
    return {
      ptyId: spec.id,
      index: index + 1,
      cli: spec.cliId ?? "shell",
      title: spec.title ?? null,
      cwd: spec.cwd ?? project.path,
      state: live ? "live" : spec.suspended ? "suspended" : "exited",
      focused: manager?.focusedPaneId === spec.id,
      runningCommand: running.get(spec.id) ?? null,
      lastOutputSecondsAgo: pane ? Math.round((Date.now() - pane.lastActivityAt) / 1000) : null,
      model: agent?.model ?? null,
      contextTokens: agent?.contextTokens ?? null,
      contextLimit: agent?.contextLimit ?? null,
    };
  });
}

function findLivePane(ctx: ToolContext, ptyId: string) {
  const found = ctx.router.findPaneById(ptyId);
  if (!found || !found.manager.isLive(ptyId)) {
    throw new ToolError(`no live terminal with ptyId "${ptyId}" (see polakapi_project_status)`);
  }
  return found;
}

const PROJECT_ARG = {
  type: "string",
  description: "Project id, unique name or absolute path. Defaults to the active project.",
};

const PTY_ARG = { type: "string", description: "Terminal ptyId from polakapi_project_status." };

export const terminalTools: ToolDef[] = [
  {
    name: "polakapi_project_status",
    description:
      "Describe one project: its terminals (cli, state, foreground command, seconds since last output, focus, model and context usage for AI CLIs) and its activity state.",
    inputSchema: { type: "object", properties: { project: PROJECT_ARG } },
    run: async (args, ctx) => {
      const state = requireController(ctx).getState();
      const { project, workspace } = resolveProject(state, args);
      const [running, agents] = await Promise.all([runningCommands(), agentSummaries()]);
      const manager = ctx.router.getById(project.id);
      return {
        id: project.id,
        name: project.name,
        path: project.path,
        workspace: { id: workspace.id, name: workspace.name },
        active: state.activeProjectId === project.id,
        activity: ctx.router.getActivity(project.id),
        defaultCli: project.activeCliId ?? "shell",
        terminals: terminalRows(project, manager, running, agents),
      };
    },
  },
  {
    name: "polakapi_agents_status",
    description:
      "List every live AI CLI pane across all projects with its project, model, context usage, foreground command and seconds since last output.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async (_args, ctx) => {
      const state = requireController(ctx).getState();
      const [running, agents] = await Promise.all([runningCommands(), agentSummaries()]);
      return ctx.router
        .livePanes()
        .filter((pane) => pane.cliId && pane.cliId !== "shell")
        .map((pane) => {
          const project = findProjectByRef(state, pane.projectId).project;
          const agent = agents.get(pane.paneId);
          return {
            ptyId: pane.paneId,
            project: { id: project.id, name: project.name },
            cli: pane.cliId,
            cwd: pane.cwd ?? project.path,
            activity: ctx.router.getActivity(pane.projectId),
            runningCommand: running.get(pane.paneId) ?? null,
            lastOutputSecondsAgo: Math.round((Date.now() - pane.lastActivityAt) / 1000),
            model: agent?.model ?? null,
            contextTokens: agent?.contextTokens ?? null,
            contextLimit: agent?.contextLimit ?? null,
          };
        });
    },
  },
  {
    name: "polakapi_open_terminal",
    description:
      "Open a new terminal pane in a project, running a shell or an AI CLI. Activates the project. Returns the new ptyId.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_ARG,
        cli: {
          type: "string",
          description: `"shell" or one of: ${AI_CLI_PROFILES.map((p) => p.id).join(", ")}. Defaults to the project's default CLI.`,
        },
        cwd: { type: "string", description: "Working directory. Defaults to the project path." },
      },
    },
    run: async (args, ctx) => {
      const controller = requireController(ctx);
      const { project } = resolveProject(controller.getState(), args);
      const cli = optionalString(args, "cli");
      if (cli && cli !== "shell" && !AI_CLI_PROFILES.some((p) => p.id === cli)) {
        throw new ToolError(`unknown cli "${cli}"`);
      }
      controller.setActiveProject(project.id);
      const manager = ctx.router.getOrCreate(project);
      const pane = await manager.addPane({
        cwd: optionalString(args, "cwd") ?? project.path,
        cliId: cli ?? project.activeCliId ?? "shell",
      });
      if (!pane?.ptyId) throw new ToolError("the terminal could not be spawned");
      return { ptyId: pane.ptyId, project: project.id, cli: cli ?? project.activeCliId ?? "shell" };
    },
  },
  {
    name: "polakapi_send_to_terminal",
    description:
      "Paste text into a live terminal pane. With submit=true an Enter follows, so a CLI prompt or shell command runs immediately; otherwise the user reviews it first.",
    inputSchema: {
      type: "object",
      properties: {
        ptyId: PTY_ARG,
        text: { type: "string", description: "Text to paste." },
        submit: { type: "boolean", description: "Press Enter after pasting. Default false." },
      },
      required: ["ptyId", "text"],
    },
    run: async (args, ctx) => {
      const ptyId = requiredString(args, "ptyId");
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) throw new ToolError('"text" is required');
      findLivePane(ctx, ptyId);
      const submit = optionalBoolean(args, "submit") ?? false;
      await ptyWrite(ptyId, bracketedPaste(text) + (submit ? "\r" : ""));
      return { ptyId, chars: text.length, submitted: submit };
    },
  },
  {
    name: "polakapi_read_terminal",
    description: "Return the last lines a terminal pane shows (plain text, scrollback included).",
    inputSchema: {
      type: "object",
      properties: {
        ptyId: PTY_ARG,
        lines: { type: "integer", description: "How many lines, 1 to 500. Default 80." },
      },
      required: ["ptyId"],
    },
    run: (args, ctx) => {
      const ptyId = requiredString(args, "ptyId");
      const { pane } = findLivePane(ctx, ptyId);
      const lines = optionalInteger(args, "lines", { min: 1, max: 500 }) ?? 80;
      return pane.readScreen(lines);
    },
  },
  {
    name: "polakapi_suspend_project",
    description: "Suspend every live terminal of a project (processes are stopped, specs kept).",
    inputSchema: { type: "object", properties: { project: PROJECT_ARG } },
    run: (args, ctx) => {
      const { project } = resolveProject(requireController(ctx).getState(), args);
      const manager = ctx.router.getById(project.id);
      const before = manager?.size ?? 0;
      manager?.suspendAll();
      return { project: project.id, suspended: before };
    },
  },
  {
    name: "polakapi_resume_project",
    description: "Resume every suspended terminal of a project. Activates the project.",
    inputSchema: { type: "object", properties: { project: PROJECT_ARG } },
    run: async (args, ctx) => {
      const controller = requireController(ctx);
      const { project } = resolveProject(controller.getState(), args);
      controller.setActiveProject(project.id);
      const manager = ctx.router.getOrCreate(project);
      const before = manager.suspendedCount;
      await manager.resumeAll();
      return { project: project.id, resumed: before };
    },
  },
];
