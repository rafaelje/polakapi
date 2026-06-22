import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "layout.json";

export interface PersistedLayout {
  sidebarLeftWidth?: number;
  sidebarRightWidth?: number;
  hideLeft?: boolean;
  hideRight?: boolean;
  hideNotes?: boolean;
  notesHeight?: number;
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
  const store = await getStore();
  const current = (await store.get<PersistedLayout>("layout")) ?? {};
  const merged = { ...current, ...pending };
  pending = {};
  await store.set("layout", merged);
  await store.save();
}
