import { load, type Store } from "@tauri-apps/plugin-store";

import type { LoopProfilesState } from "../../modules/loop/state/types";

// Patrón replicado de `workspaces-store.ts`. Decisiones equivalentes:
// - El store es un único archivo JSON (`profiles.json`), una key `state`,
//   un único snapshot completo (no patches).
// - `queueSaveLoopProfiles` debouncea writes en una ventana corta para que
//   ráfagas de UI (ej. editar el dropdown de CLI/modelo varias veces) no
//   gatillen 1 write por cambio.
// - `schemaVersion` mismatch => silent fallback a estado vacío (no romper boot
//   por data vieja). Misma semántica que workspaces — ver
//   `loop-profiles/spec.md` requirement "Schema version incompatible".

const STORE_FILE = "profiles.json";
const STATE_KEY = "state";
// 250ms alineado con la versión original de F1 de workspaces. Profiles se
// modifican manualmente, no hay ráfagas tan altas como en terminales (F2 lo
// subió a 300ms por eso). 250 es suficiente.
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
 * Carga el estado persistido. Devuelve estado vacío cuando no hay nada
 * guardado o cuando el `schemaVersion` no matchea — nunca tira. Mismo
 * contrato que `loadWorkspaces`.
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
 * Encola un snapshot completo del estado de perfiles. Llamadas dentro de la
 * ventana de debounce colapsan al último snapshot.
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
  // Snapshot antes de cualquier `await` para que una llamada concurrente a
  // `queueSaveLoopProfiles` aterrize en un `pending` nuevo y no se pierda al
  // ponerlo en null debajo. Mismo razonamiento que `workspaces-store.ts:73`.
  const snapshot = pending;
  pending = null;
  try {
    const store = await getStore();
    await store.set(STATE_KEY, snapshot);
    await store.save();
  } catch (error) {
    // Restauramos el snapshot si nadie escribió uno más nuevo, así el próximo
    // flush reintenta. (Si ya hay uno nuevo, gana ese — es un snapshot
    // completo, no un patch).
    if (pending === null) pending = snapshot;
    throw error;
  }
}
