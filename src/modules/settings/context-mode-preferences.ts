import { load } from "@tauri-apps/plugin-store";
import { emit, listen } from "@tauri-apps/api/event";

// Configuration for context mode: which agent CLIs route their tool output
// into a local store instead of the model's context, and whether that store
// survives the session.
//
// See docs/context-mode-plan.md. The enforcement each CLI can offer differs a
// lot, which is why the toggles are per-CLI rather than one global switch.

export type ContextModeCli = "claude" | "codex" | "opencode" | "cursor";

/** Where the offloaded data lives. */
export type ContextStorage =
  /** Temp folder, discarded when the session ends. */
  | "ephemeral"
  /** Temp folder, moved into the project once the session grows. */
  | "promote"
  /** Always inside the project, from the first byte. */
  | "project";

export interface ContextModePreferences {
  enabled: boolean;
  clis: Record<ContextModeCli, boolean>;
  storage: ContextStorage;
  /** Sessions with more offloaded sources than this move into the project. */
  promoteAfterSources: number;
  /** Output smaller than this skips offloading; the machinery would cost more
   * than it saves. */
  bypassKb: number;
  /** Output larger than this is indexed and replaced by a query pointer. */
  externalizeKb: number;
}

export interface ContextModeCliInfo {
  id: ContextModeCli;
  label: string;
  /** What polakapi can actually enforce for this CLI today. */
  enforcement: string;
}

export const CONTEXT_MODE_CLIS: readonly ContextModeCliInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    enforcement:
      "Active: a hook reroutes large shell output (git log, gh, cat, find…) before it reaches the model, and tells it how to search what was stored.",
  },
  {
    id: "codex",
    label: "Codex",
    enforcement:
      "Not connected yet: Codex's hook output format has not been verified, so no hook is installed and this toggle has no effect.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    enforcement:
      "Not connected yet: polakapi has not verified a hook for it, so this toggle has no effect.",
  },
  {
    id: "cursor",
    label: "Cursor",
    enforcement:
      "Active for the cursor-agent CLI: a hook reroutes large shell output before it reaches the model, and tells it how to search what was stored.",
  },
];

export const contextModeDefaults: ContextModePreferences = {
  enabled: false,
  // Nothing is switched on for the user: every CLI writes hooks into a global
  // settings file, so enabling one has to be their decision.
  clis: { claude: false, codex: false, opencode: false, cursor: false },
  storage: "promote",
  promoteAfterSources: 20,
  bypassKb: 4,
  externalizeKb: 100,
};

const STORAGE_MODES: readonly ContextStorage[] = ["ephemeral", "promote", "project"];

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeClis(value: unknown): Record<ContextModeCli, boolean> {
  const source = (value && typeof value === "object" ? value : {}) as Partial<
    Record<ContextModeCli, unknown>
  >;
  const out = {} as Record<ContextModeCli, boolean>;
  for (const cli of CONTEXT_MODE_CLIS) {
    const flag = source[cli.id];
    out[cli.id] = typeof flag === "boolean" ? flag : contextModeDefaults.clis[cli.id];
  }
  return out;
}

export function normalizeContextMode(value: unknown): ContextModePreferences {
  const p = (value && typeof value === "object" ? value : {}) as Partial<ContextModePreferences>;
  const bypassKb = clampInt(p.bypassKb, contextModeDefaults.bypassKb, 0, 1024);
  const externalizeKb = clampInt(p.externalizeKb, contextModeDefaults.externalizeKb, 1, 100_000);
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : contextModeDefaults.enabled,
    clis: normalizeClis(p.clis),
    storage: STORAGE_MODES.includes(p.storage as ContextStorage)
      ? (p.storage as ContextStorage)
      : contextModeDefaults.storage,
    promoteAfterSources: clampInt(
      p.promoteAfterSources,
      contextModeDefaults.promoteAfterSources,
      1,
      10_000,
    ),
    bypassKb,
    // An externalize threshold at or below the bypass threshold would leave no
    // band for summarising, so it is pushed above it rather than accepted.
    externalizeKb: Math.max(externalizeKb, bypassKb + 1),
  };
}

/** True when this CLI should actually route through context mode. */
export function isCliEnabled(preferences: ContextModePreferences, cli: ContextModeCli): boolean {
  return preferences.enabled && preferences.clis[cli];
}

const store = () => load("context-mode.json", { autoSave: false, defaults: {} });

export async function loadContextMode(): Promise<ContextModePreferences> {
  return normalizeContextMode(await (await store()).get("preferences"));
}

export async function saveContextMode(preferences: ContextModePreferences): Promise<void> {
  const db = await store();
  await db.set("preferences", preferences);
  await db.save();
  await emit("context-mode-preferences", preferences);
}

export function watchContextMode(
  onChange: (preferences: ContextModePreferences) => void,
): Promise<() => void> {
  return listen("context-mode-preferences", (event) =>
    onChange(normalizeContextMode(event.payload)),
  );
}
