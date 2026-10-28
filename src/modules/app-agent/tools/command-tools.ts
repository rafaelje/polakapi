import { invoke } from "../../../shared/tauri/invoke";
import {
  sortedProjectsInFolder,
  sortedWorkspaces,
} from "../../workspaces/state/workspaces-reducer";
import type { WorkspacesState } from "../../workspaces/state/types";
import { listTerminals, runInTerminal } from "../terminal-remote";
import { requiredString } from "./args";
import { resolveProject } from "./resolve";
import { requireController, ToolError, type ToolContext, type ToolDef } from "./types";

// A shell command in a project directory, answered with the transcript a
// terminal would show. Distinct from typing into a pane: nothing appears in
// the user's terminals and the output comes back whole.

interface RunResult {
  transcript: string;
  exitCode: number | null;
  timedOut: boolean;
}

function sidebarProjects(state: WorkspacesState): Array<{ id: string; name: string }> {
  return sortedWorkspaces(state).flatMap((workspace) =>
    [
      ...(workspace.folders ?? []).flatMap((folder) =>
        sortedProjectsInFolder(workspace, folder.id),
      ),
      ...sortedProjectsInFolder(workspace, undefined),
    ].map((project) => ({ id: project.id, name: project.name })),
  );
}

function terminals(ctx: ToolContext) {
  return listTerminals(ctx.router.livePanes(), sidebarProjects(requireController(ctx).getState()));
}

export const commandTools: ToolDef[] = [
  {
    name: "polakapi_terminals",
    description:
      'List every live terminal pane across projects with its ptyId, project, cli ("shell" or an AI CLI), current working directory (follows cd) and the program running in it, if any.',
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (_args, ctx) => terminals(ctx),
  },
  {
    name: "polakapi_run_in_terminal",
    description:
      "Type a shell command into one of the user's shell panes, press Enter, wait for it to finish (up to 60 s) and return what it printed, as the terminal shows it. Runs in that shell's state (its cwd, virtualenv, variables). Refuses panes that run an AI CLI or another program.",
    inputSchema: {
      type: "object",
      properties: {
        ptyId: { type: "string", description: "Terminal ptyId from polakapi_terminals." },
        command: { type: "string", description: "One command line." },
      },
      required: ["ptyId", "command"],
    },
    run: async (args, ctx) => {
      const ptyId = requiredString(args, "ptyId");
      const command = requiredString(args, "command");
      const found = ctx.router.findPaneById(ptyId);
      if (!found || !found.manager.isLive(ptyId)) {
        throw new ToolError(`no live terminal with ptyId "${ptyId}" (see polakapi_terminals)`);
      }
      const info = (await terminals(ctx)).find((row) => row.ptyId === ptyId);
      if (info && info.cli !== "shell") {
        throw new ToolError(
          `that pane runs ${info.cli}; send it a prompt with polakapi_send_to_terminal instead`,
        );
      }
      if (info?.busy) {
        throw new ToolError(`that terminal is busy running ${info.busy}; pick another one`);
      }
      const run = await runInTerminal(found.pane, ptyId, command).catch((error: unknown) => {
        throw new ToolError(String(error instanceof Error ? error.message : error));
      });
      return run.transcript;
    },
  },
  {
    name: "polakapi_run_command",
    description:
      "Run a shell command (git status, git branch, ls, a test script…) in a project's directory and return its output as a terminal shows it: `$ command`, the output, and `[exit N]` when it failed. Times out after 60 seconds; not for interactive programs.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project id, unique name or path. Defaults to the active project.",
        },
        command: { type: "string", description: "The command line, run by the user's shell." },
      },
      required: ["command"],
    },
    run: async (args, ctx) => {
      const command = requiredString(args, "command");
      const { project } = resolveProject(requireController(ctx).getState(), args);
      if (project.pathInvalid) throw new ToolError(`${project.name}'s folder is missing`);
      const result = await invoke<RunResult>(
        "app_run_command",
        { cwd: project.path, command },
        { toastOnError: false },
      ).catch((error: unknown) => {
        throw new ToolError(`could not run the command: ${String(error)}`);
      });
      return result.transcript;
    },
  },
];
