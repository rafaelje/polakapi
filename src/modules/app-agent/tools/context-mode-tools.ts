import { invoke } from "../../../shared/tauri/invoke";
import {
  CONTEXT_MODE_CLIS,
  loadContextMode,
  saveContextMode,
  type ContextModeCli,
  type ContextModePreferences,
} from "../../settings/context-mode-preferences";
import { optionalBoolean } from "./args";
import { ToolError, type ToolDef } from "./types";

// Context mode: the master switch and the per-CLI switches, synced to the CLI
// hook files the same way the settings window does it.

function describe(preferences: ContextModePreferences) {
  return {
    enabled: preferences.enabled,
    clis: CONTEXT_MODE_CLIS.map((info) => ({
      id: info.id,
      label: info.label,
      enabled: preferences.clis[info.id],
      effective: preferences.enabled && preferences.clis[info.id],
      enforcement: info.enforcement,
    })),
    storage: preferences.storage,
    promoteAfterSources: preferences.promoteAfterSources,
    bypassKb: preferences.bypassKb,
    externalizeKb: preferences.externalizeKb,
  };
}

export const contextModeTools: ToolDef[] = [
  {
    name: "polakapi_context_mode_status",
    description:
      "Show context mode: whether it is on, which CLIs it applies to, and where offloaded output is stored.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => describe(await loadContextMode()),
  },
  {
    name: "polakapi_context_mode_set",
    description:
      "Turn context mode on or off and/or switch it per CLI. Omitted fields keep their value. Hooks are re-synced after saving.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Master switch." },
        clis: {
          type: "object",
          description: 'Per-CLI switches, e.g. {"claude": true, "cursor": false}.',
          properties: Object.fromEntries(
            CONTEXT_MODE_CLIS.map((info) => [info.id, { type: "boolean" }]),
          ),
          additionalProperties: false,
        },
      },
    },
    run: async (args) => {
      const current = await loadContextMode();
      const next: ContextModePreferences = { ...current, clis: { ...current.clis } };
      const enabled = optionalBoolean(args, "enabled");
      if (enabled !== undefined) next.enabled = enabled;
      const clis = args.clis;
      if (clis !== undefined && clis !== null) {
        if (typeof clis !== "object" || Array.isArray(clis)) {
          throw new ToolError('"clis" must be an object of booleans');
        }
        for (const [key, value] of Object.entries(clis as Record<string, unknown>)) {
          if (!CONTEXT_MODE_CLIS.some((info) => info.id === key)) {
            throw new ToolError(`unknown cli "${key}" in "clis"`);
          }
          if (typeof value !== "boolean") throw new ToolError(`"clis.${key}" must be a boolean`);
          next.clis[key as ContextModeCli] = value;
        }
      }
      if (enabled === undefined && (clis === undefined || clis === null)) {
        throw new ToolError('pass "enabled" and/or "clis"');
      }
      await saveContextMode(next);
      try {
        await invoke("ctx_sync_hooks", {}, { toastOnError: false });
      } catch (error) {
        throw new ToolError(`saved, but hooks could not be synced: ${String(error)}`);
      }
      return describe(next);
    },
  },
];
