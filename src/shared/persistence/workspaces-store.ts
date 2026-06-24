import { load, type Store } from "@tauri-apps/plugin-store";

import type { WorkspacesState } from "../../modules/workspaces/state/types";

const STORE_FILE = "workspaces.json";
const STATE_KEY = "state";
// Bumped from 250ms in F1 to 300ms for F2: terminal-spec writes fire more
// frequently (spawn/close/rename/cols) and tend to cluster, so the wider
// window collapses more of them into a single full-state snapshot.
const DEBOUNCE_MS = 300;
const CURRENT_SCHEMA_VERSION = 1;

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: false, defaults: {} });
  return storePromise;
}

export function createEmptyWorkspacesState(): WorkspacesState {
  return {
    workspaces: [],
    activeProjectId: null,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
}

function isWorkspacesState(value: unknown): value is WorkspacesState {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<WorkspacesState>;
  return (
    v.schemaVersion === CURRENT_SCHEMA_VERSION &&
    Array.isArray(v.workspaces) &&
    (v.activeProjectId === null || typeof v.activeProjectId === "string")
  );
}

/**
 * Loads the persisted workspaces state. Returns an empty state when nothing is
 * stored or when the persisted document has an incompatible schemaVersion.
 * Never throws on schema mismatches — bad data is silently discarded so the
 * app can boot.
 */
export async function loadWorkspaces(): Promise<WorkspacesState> {
  const store = await getStore();
  const value = await store.get<unknown>(STATE_KEY);
  if (!isWorkspacesState(value)) return createEmptyWorkspacesState();
  return value;
}

let pending: WorkspacesState | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Queues a full WorkspacesState snapshot to be persisted. Calls within a
 * 250ms window collapse to a single write of the latest snapshot.
 */
export function queueSaveWorkspaces(state: WorkspacesState): void {
  pending = state;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void flushSaveWorkspaces();
  }, DEBOUNCE_MS);
}

export async function flushSaveWorkspaces(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pending === null) return;
  // Snapshot before any await so a concurrent queueSaveWorkspaces() call lands
  // in a fresh `pending` bucket and is not lost when we null it below.
  const snapshot = pending;
  pending = null;
  try {
    const store = await getStore();
    await store.set(STATE_KEY, snapshot);
    await store.save();
  } catch (error) {
    // Restore the snapshot so a later flush retries it, unless a newer write
    // already landed (in which case the newer one wins — it is a full state
    // snapshot, not a patch).
    if (pending === null) pending = snapshot;
    throw error;
  }
}
