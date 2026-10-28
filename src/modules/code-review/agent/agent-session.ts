import { isAgentCli, type AgentCli } from "../../../shared/agent-cli";
import { resolveProfile } from "../../terminal/cli-registry";

export interface AgentSelection {
  cli: AgentCli;
  model: string;
}

export interface AgentSpawnSpec {
  cliId: AgentCli;
  command: string;
  args: string[];
  cwd: string;
}

export interface AgentSelectionChange {
  cli?: string;
  model?: string;
}

export function initialAgentSelection(): AgentSelection {
  return { cli: "claude", model: "" };
}

export function changeAgentSelection(
  current: AgentSelection,
  change: AgentSelectionChange,
): AgentSelection {
  if (change.cli !== undefined) {
    if (!isAgentCli(change.cli) || change.cli === current.cli) return current;
    return { cli: change.cli, model: "" };
  }
  if (change.model !== undefined) {
    const model = change.model.trim();
    return model === current.model ? current : { ...current, model };
  }
  return current;
}

export function shouldRestartAgent(running: AgentSelection | null, next: AgentSelection): boolean {
  return running === null || running.cli !== next.cli || running.model !== next.model;
}

export function agentSpawnSpec(selection: AgentSelection, cwd: string): AgentSpawnSpec {
  const model = selection.model.trim();
  return {
    cliId: selection.cli,
    command: resolveProfile(selection.cli).command,
    args: model ? ["--model", model] : [],
    cwd,
  };
}
