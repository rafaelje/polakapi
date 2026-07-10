import { load, type Store } from "@tauri-apps/plugin-store";

import type { AgentsState } from "../../modules/agents-library/types";

// Adapted line-for-line from `loop-profiles-store.ts` — same debounced full
// snapshot pattern, same `schemaVersion` silent-fallback contract. Agents
// are a small collection edited manually, no cross-session query needs, so
// a JSON snapshot beats SQLite for v1.

const STORE_FILE = "agents.json";
const STATE_KEY = "state";
const DEBOUNCE_MS = 250;
const CURRENT_SCHEMA_VERSION = 1;

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: false, defaults: {} });
  return storePromise;
}

export function createEmptyAgentsState(): AgentsState {
  return {
    agents: [],
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
}

function isAgentsState(value: unknown): value is AgentsState {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<AgentsState>;
  return v.schemaVersion === CURRENT_SCHEMA_VERSION && Array.isArray(v.agents);
}

export async function loadAgents(): Promise<AgentsState> {
  const store = await getStore();
  const value = await store.get<unknown>(STATE_KEY);
  if (!isAgentsState(value)) return createEmptyAgentsState();
  return value;
}

let pending: AgentsState | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function queueSaveAgents(state: AgentsState): void {
  pending = state;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void flushSaveAgents();
  }, DEBOUNCE_MS);
}

export async function flushSaveAgents(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pending === null) return;
  // Snapshot before any `await` so a concurrent queueSaveAgents lands in a
  // fresh `pending` and isn't lost when we null it out below (same reasoning
  // as loop-profiles-store.ts:79).
  const snapshot = pending;
  pending = null;
  try {
    const store = await getStore();
    await store.set(STATE_KEY, snapshot);
    await store.save();
  } catch (error) {
    if (pending === null) pending = snapshot;
    throw error;
  }
}
