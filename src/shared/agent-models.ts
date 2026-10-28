import { invoke } from "@tauri-apps/api/core";
import type { AgentCli } from "./agent-cli";

export interface ModelOption {
  id: string;
  label: string;
}

export interface ModelChoice {
  value: string;
  label: string;
}

const cache = new Map<AgentCli, Promise<ModelOption[]>>();

export function fetchAgentModels(cli: AgentCli): Promise<ModelOption[]> {
  let pending = cache.get(cli);
  if (!pending) {
    pending = invoke<ModelOption[]>("agent_cli_models", { cli });
    pending.catch(() => cache.delete(cli));
    cache.set(cli, pending);
  }
  return pending;
}

export function modelChoices(
  models: readonly ModelOption[],
  current: string,
  defaultLabel: string,
): ModelChoice[] {
  const choices: ModelChoice[] = [{ value: "", label: defaultLabel }];
  for (const model of models) {
    const label = model.label === model.id ? model.id : `${model.label} (${model.id})`;
    choices.push({ value: model.id, label });
  }
  if (current && !models.some((model) => model.id === current)) {
    choices.push({ value: current, label: current });
  }
  return choices;
}
