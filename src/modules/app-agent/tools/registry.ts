import { stringifyError } from "../../../shared/errors";
import { commandTools } from "./command-tools";
import { contextModeTools } from "./context-mode-tools";
import { libraryTools } from "./library-tools";
import { reviewTools } from "./review-tools";
import { terminalTools } from "./terminal-tools";
import {
  ToolError,
  type ToolArgs,
  type ToolContext,
  type ToolDef,
  type ToolDescriptor,
  type ToolResult,
} from "./types";
import { workspaceTools } from "./workspace-tools";

// Single catalog served to `polakapi app-mcp`. Tool names are what the model
// sees; keep them stable, since the operator brief refers to them.

const MAX_RESULT_CHARS = 200_000;

/** `full` is the agent tab; `readonly` is what the Telegram bot gets by default. */
export type ToolProfile = "full" | "readonly";

export const READONLY_TOOLS: ReadonlySet<string> = new Set([
  "polakapi_overview",
  "polakapi_project_status",
  "polakapi_agents_status",
  "polakapi_read_terminal",
  "polakapi_terminals",
  "polakapi_skills_list",
  "polakapi_skill_read",
  "polakapi_memory_list",
  "polakapi_memory_read",
  "polakapi_agent_context",
  "polakapi_agent_context_search",
  "polakapi_agent_context_entry",
  "polakapi_adversarial_status",
  "polakapi_adversarial_findings",
  "polakapi_context_mode_status",
]);

/** Anything but an explicit "readonly" keeps today's behaviour for the agent tab. */
export function toProfile(value: unknown): ToolProfile {
  return value === "readonly" ? "readonly" : "full";
}

function allowed(name: string, profile: ToolProfile): boolean {
  return profile === "full" || READONLY_TOOLS.has(name);
}

export interface ToolRegistry {
  list(profile?: ToolProfile): ToolDescriptor[];
  call(name: string, args: unknown, profile?: ToolProfile): Promise<ToolResult>;
}

export function allTools(): ToolDef[] {
  return [
    ...workspaceTools,
    ...terminalTools,
    ...commandTools,
    ...libraryTools,
    ...reviewTools,
    ...contextModeTools,
  ];
}

function formatResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "ok";
  const text = JSON.stringify(value, null, 2);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated)`;
}

export function createToolRegistry(ctx: ToolContext): ToolRegistry {
  const tools = new Map<string, ToolDef>();
  for (const tool of allTools()) {
    if (tools.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    tools.set(tool.name, tool);
  }

  return {
    list: (profile = "full") =>
      [...tools.values()]
        .filter((tool) => allowed(tool.name, profile))
        .map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
    call: async (name, args, profile = "full") => {
      const tool = tools.get(name);
      if (!tool) return { text: `unknown tool: ${name}`, isError: true };
      if (!allowed(name, profile)) {
        return { text: `${name} is not available in the ${profile} profile`, isError: true };
      }
      const safeArgs: ToolArgs =
        args && typeof args === "object" && !Array.isArray(args) ? (args as ToolArgs) : {};
      try {
        return { text: formatResult(await tool.run(safeArgs, ctx)), isError: false };
      } catch (error) {
        if (error instanceof ToolError) return { text: error.message, isError: true };
        console.error(`app-agent tool ${name} failed`, error);
        return { text: `${name} failed: ${stringifyError(error)}`, isError: true };
      }
    },
  };
}
