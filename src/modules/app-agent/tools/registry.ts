import { stringifyError } from "../../../shared/errors";
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

export interface ToolRegistry {
  list(): ToolDescriptor[];
  call(name: string, args: unknown): Promise<ToolResult>;
}

export function allTools(): ToolDef[] {
  return [
    ...workspaceTools,
    ...terminalTools,
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
    list: () =>
      [...tools.values()].map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    call: async (name, args) => {
      const tool = tools.get(name);
      if (!tool) return { text: `unknown tool: ${name}`, isError: true };
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
