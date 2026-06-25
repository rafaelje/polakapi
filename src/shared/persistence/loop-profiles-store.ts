import { load, type Store } from "@tauri-apps/plugin-store";

import type { LoopProfilesState } from "../../modules/loop/state/types";

// Pattern replicated from `workspaces-store.ts`. Equivalent decisions:
// - The store is a single JSON file (`profiles.json`), one `state` key,
//   a single full snapshot (no patches).
// - `queueSaveLoopProfiles` debounces writes in a short window so UI bursts
//   (e.g. editing the CLI/model dropdown several times) don't trigger one
//   write per change.
// - `schemaVersion` mismatch => silent fallback to empty state (don't break
//   boot on old data). Same semantics as workspaces — see
//   `loop-profiles/spec.md` requirement "Schema version incompatible".

const STORE_FILE = "profiles.json";
const STATE_KEY = "state";
// 250ms aligned with the original F1 version of workspaces. Profiles are
// modified manually, there are no bursts as high as in terminals (F2 bumped
// it to 300ms for that). 250 is enough.
const DEBOUNCE_MS = 250;
const CURRENT_SCHEMA_VERSION = 1;

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: false, defaults: {} });
  return storePromise;
}

export function createEmptyLoopProfilesState(): LoopProfilesState {
  return {
    profiles: [],
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
}

function isLoopProfilesState(value: unknown): value is LoopProfilesState {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<LoopProfilesState>;
  return v.schemaVersion === CURRENT_SCHEMA_VERSION && Array.isArray(v.profiles);
}

/**
 * Loads the persisted state. Returns empty state when nothing is saved or
 * when `schemaVersion` does not match — never throws. Same contract as
 * `loadWorkspaces`.
 */
export async function loadLoopProfiles(): Promise<LoopProfilesState> {
  const store = await getStore();
  const value = await store.get<unknown>(STATE_KEY);
  if (!isLoopProfilesState(value)) return createEmptyLoopProfilesState();
  return value;
}

let pending: LoopProfilesState | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Queues a full snapshot of the profiles state. Calls within the debounce
 * window collapse to the latest snapshot.
 */
export function queueSaveLoopProfiles(state: LoopProfilesState): void {
  pending = state;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void flushSaveLoopProfiles();
  }, DEBOUNCE_MS);
}

export async function flushSaveLoopProfiles(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pending === null) return;
  // Snapshot before any `await` so that a concurrent call to
  // `queueSaveLoopProfiles` lands in a fresh `pending` and isn't lost when
  // we null it out below. Same reasoning as `workspaces-store.ts:73`.
  const snapshot = pending;
  pending = null;
  try {
    const store = await getStore();
    await store.set(STATE_KEY, snapshot);
    await store.save();
  } catch (error) {
    // Restore the snapshot if no one wrote a newer one, so the next flush
    // retries. (If there's already a newer one, that one wins — it's a full
    // snapshot, not a patch).
    if (pending === null) pending = snapshot;
    throw error;
  }
}
