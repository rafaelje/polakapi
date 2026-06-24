import { load, type Store } from "@tauri-apps/plugin-store";
import type { BottomTab } from "../../modules/bottom-panel/types";

const STORE_FILE = "layout.json";

export interface PersistedLayout {
  sidebarLeftWidth?: number;
  sidebarRightWidth?: number;
  hideLeft?: boolean;
  hideRight?: boolean;
  hideNotes?: boolean;
  notesHeight?: number;
  activeBottomTab?: BottomTab;
  /**
   * @deprecated F3: notes content is now stored per-project in workspaces.json.
   * Kept in the type so older layout.json files still load without runtime
   * narrowing errors. No code reads or writes this field after F3.
   */
  notesContent?: string;
}

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: false, defaults: {} });
  return storePromise;
}

export async function loadLayout(): Promise<PersistedLayout> {
  const store = await getStore();
  const value = await store.get<PersistedLayout>("layout");
  return value ?? {};
}

let pending: PersistedLayout = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function queueSave(patch: Partial<PersistedLayout>): void {
  pending = { ...pending, ...patch };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void flushSave();
  }, 250);
}

export async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (Object.keys(pending).length === 0) return;
  // Snapshot before any await so concurrent queueSave() calls land in a fresh
  // `pending` bucket and are not clobbered by `pending = {}` below.
  const snapshot = pending;
  pending = {};
  try {
    const store = await getStore();
    const current = (await store.get<PersistedLayout>("layout")) ?? {};
    const merged = { ...current, ...snapshot };
    await store.set("layout", merged);
    await store.save();
  } catch (error) {
    // Restore snapshot so the next flush retries it, without clobbering newer
    // patches that may have been queued during the failed await.
    pending = { ...snapshot, ...pending };
    throw error;
  }
}
