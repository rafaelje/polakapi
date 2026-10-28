import type { TerminalRouter } from "../../../app/terminal-router";
import type { WorkspacesController } from "../../workspaces/state/workspaces-controller";
import type { AdversarialRunner } from "../adversarial-runner";

// A tool is a JSON-schema'd function the operator agent can call through the
// `polakapi` MCP server. The schema is what the CLI shows the model, so it is
// written for the model: short, with every argument explained.

export interface ToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  getController(): WorkspacesController | null;
  router: TerminalRouter;
  adversarial: AdversarialRunner;
}

export type ToolArgs = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  run(args: ToolArgs, ctx: ToolContext): unknown;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: ToolSchema;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

/** A failure the model should read and act on, as opposed to a crash. */
export class ToolError extends Error {}

export function requireController(ctx: ToolContext) {
  const controller = ctx.getController();
  if (!controller) throw new ToolError("workspaces are still loading; retry in a moment");
  return controller;
}
