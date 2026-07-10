import {
  createEmptyAgentsState,
  flushSaveAgents,
  loadAgents,
  queueSaveAgents,
} from "../../shared/persistence/agents-store";
import type {
  AgentCreateInput,
  AgentDef,
  AgentFile,
  AgentFileInput,
  AgentUpdateInput,
  AgentsState,
} from "./types";

// In-memory state ownership + CRUD wrapped around the JSON store. Same
// shape as `WorkspacesController` / `LoopProfilesController` — subscribe
// for change notifications, mutations return the new AgentDef and queue a
// debounced snapshot to disk.

export interface AgentsController {
  getState(): AgentsState;
  subscribe(fn: (state: AgentsState) => void): () => void;
  create(input: AgentCreateInput): AgentDef;
  update(id: string, patch: AgentUpdateInput): AgentDef;
  remove(id: string): void;
  dispose(): Promise<void>;
}

/** Thrown by create/update when the name collides with another agent. */
export class DuplicateAgentNameError extends Error {
  constructor(name: string) {
    super(`agent name already exists: ${name}`);
    this.name = "DuplicateAgentNameError";
  }
}

function normName(name: string): string {
  return name.trim().toLowerCase();
}

function materializeFiles(inputs: AgentFileInput[]): AgentFile[] {
  return inputs.map((f) => ({
    id: crypto.randomUUID(),
    title: f.title.trim(),
    content: f.content,
  }));
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("agent name is required");
  return trimmed;
}

function validateFiles(files: AgentFileInput[]): AgentFileInput[] {
  if (files.length === 0) throw new Error("agent needs at least one file");
  const cleaned = files.map((f) => ({
    title: f.title.trim() || "untitled.md",
    content: f.content,
  }));
  if (cleaned.every((f) => f.content.trim().length === 0)) {
    throw new Error("agent needs at least one file with content");
  }
  return cleaned;
}

export interface CreateAgentsControllerOptions {
  /** Overrideable clock so tests can assert stable timestamps. */
  now?: () => number;
  /** Override the initial state (bypasses the store) — used in tests. */
  initial?: AgentsState;
}

export async function createAgentsController(
  opts: CreateAgentsControllerOptions = {},
): Promise<AgentsController> {
  const now = opts.now ?? (() => Date.now());
  let state: AgentsState = opts.initial ?? (await loadAgents());
  const listeners = new Set<(state: AgentsState) => void>();

  const emit = (): void => {
    for (const fn of listeners) {
      try {
        fn(state);
      } catch (error) {
        console.error("AgentsController listener threw", error);
      }
    }
    queueSaveAgents(state);
  };

  const nameTaken = (name: string, exceptId?: string): boolean => {
    const target = normName(name);
    return state.agents.some((a) => a.id !== exceptId && normName(a.name) === target);
  };

  return {
    getState(): AgentsState {
      return state;
    },
    subscribe(fn): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    create(input): AgentDef {
      const name = validateName(input.name);
      if (nameTaken(name)) throw new DuplicateAgentNameError(name);
      const files = validateFiles(input.files);
      const timestamp = now();
      const agent: AgentDef = {
        id: crypto.randomUUID(),
        name,
        description: input.description.trim(),
        files: materializeFiles(files),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state = { ...state, agents: [...state.agents, agent] };
      emit();
      return agent;
    },
    update(id, patch): AgentDef {
      const idx = state.agents.findIndex((a) => a.id === id);
      if (idx < 0) throw new Error(`agent not found: ${id}`);
      const existing = state.agents[idx];
      const nextName = patch.name !== undefined ? validateName(patch.name) : existing.name;
      if (patch.name !== undefined && nameTaken(nextName, id)) {
        throw new DuplicateAgentNameError(nextName);
      }
      const nextDescription =
        patch.description !== undefined ? patch.description.trim() : existing.description;
      const nextFiles =
        patch.files !== undefined ? materializeFiles(validateFiles(patch.files)) : existing.files;
      const updated: AgentDef = {
        ...existing,
        name: nextName,
        description: nextDescription,
        files: nextFiles,
        updatedAt: now(),
      };
      const nextAgents = state.agents.slice();
      nextAgents[idx] = updated;
      state = { ...state, agents: nextAgents };
      emit();
      return updated;
    },
    remove(id): void {
      const nextAgents = state.agents.filter((a) => a.id !== id);
      if (nextAgents.length === state.agents.length) return;
      state = { ...state, agents: nextAgents };
      emit();
    },
    async dispose(): Promise<void> {
      listeners.clear();
      await flushSaveAgents();
    },
  };
}

export { createEmptyAgentsState };
