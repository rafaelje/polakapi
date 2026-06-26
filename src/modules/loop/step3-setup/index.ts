import { invoke } from "@tauri-apps/api/core";

import {
  flushSaveLoopProfiles,
  loadLoopProfiles,
  queueSaveLoopProfiles,
} from "../../../shared/persistence/loop-profiles-store";
import { stringifyError } from "../../../shared/errors";

import { parsePhasesManifest } from "../step2-phases";
import { ALL_AGENT_ROLES, LOOP_PROMPT_NAMES, createDefaultMatrix } from "../types";
import type {
  AgentSlot,
  CliValidation,
  LoopAgentRole,
  LoopProfile,
  LoopProfileId,
  LoopProfilesState,
  LoopPromptName,
} from "../types";

import { canExecute, clone, effectiveMode } from "./helpers";
import type {
  RunConfig,
  RunMode,
  Step3Action,
  Step3Context,
  Step3State,
} from "./state";
import { renderView } from "./view";

export type { RunConfig, RunMode, Step3Context };
export {
  canExecute,
  countInvalidSlots,
  effectiveMode,
  isPromptModified,
} from "./helpers";

export interface Step3Handle {
  dispose(): void;
}

export function mountStep3Setup(slot: HTMLElement, ctx: Step3Context): Step3Handle {
  const state: Step3State = {
    profiles: [],
    loadedProfileId: null,
    matrix: createDefaultMatrix(),
    mode: "sequential",
    selectedPrompt: "problem-intake.md",
    promptBuffers: new Map(),
    globals: new Map(),
    validations: new Map(),
    config: {
      maxRetries: 3,
      onFail: "propagate-warning",
    },
    status: null,
    busy: false,
    phases: [],
  };

  let disposed = false;

  const refs = renderView(slot, state, ctx, (action) => {
    void handleAction(action);
  });

  void hydrate();

  async function hydrate(): Promise<void> {
    state.busy = true;
    state.status = "loading configuration…";
    refs.refresh();
    try {
      await invoke<string[]>("loop_ensure_prompts_dir").catch(() => []);
      if (disposed) return;

      const profilesState = await loadLoopProfiles();
      if (disposed) return;
      state.profiles = profilesState.profiles;

      const globalsEntries = await Promise.all(
        LOOP_PROMPT_NAMES.map(async (name) => {
          try {
            const content = await invoke<string>("loop_read_global_prompt", { name });
            return [name, content] as const;
          } catch {
            return [name, ""] as const;
          }
        }),
      );
      if (disposed) return;
      state.globals = new Map(globalsEntries);

      try {
        const manifest = await invoke<string>("loop_read_run_file", {
          projectPath: ctx.projectPath,
          runId: ctx.runId,
          file: "02-phases.md",
        });
        if (disposed) return;
        state.phases = manifest.trim() ? parsePhasesManifest(manifest) : [];
      } catch {
        if (disposed) return;
        state.phases = [];
      }

      state.status = null;
    } catch (err) {
      if (disposed) return;
      state.status = `error loading: ${stringifyError(err)}`;
    } finally {
      if (!disposed) {
        state.busy = false;
        refs.refresh();
        void validateAllSlots();
      }
    }
  }

  async function handleAction(action: Step3Action): Promise<void> {
    switch (action.kind) {
      case "set-mode":
        state.mode = action.mode;
        refs.refresh();
        return;
      case "load-profile":
        loadProfile(action.id);
        return;
      case "save-profile":
        await saveProfile();
        return;
      case "save-profile-as":
        await saveProfileAs(action.name);
        return;
      case "set-slot": {
        const next: AgentSlot = { cli: action.cli, model: action.model };
        state.matrix = { ...state.matrix, [action.role]: next };
        refs.refresh();
        void validateSlot(action.role);
        return;
      }
      case "select-prompt":
        state.selectedPrompt = action.name;
        void loadPromptBufferIfNeeded(action.name);
        refs.refresh();
        return;
      case "set-prompt-buffer":
        state.promptBuffers.set(action.name, action.value);
        refs.refresh();
        return;
      case "reset-to-global":
        await resetToGlobal(action.name);
        return;
      case "reseed-from-bundled":
        await reseedFromBundled(action.name);
        return;
      case "promote-to-global":
        await promoteToGlobal(action.name);
        return;
      case "execute":
        await executeRun();
        return;
    }
  }

  function loadProfile(id: LoopProfileId | null): void {
    state.loadedProfileId = id;
    if (id === null) {
      state.matrix = createDefaultMatrix();
    } else {
      const p = state.profiles.find((x) => x.id === id);
      if (p) state.matrix = clone(p.matrix);
    }
    state.status = id ? "profile loaded" : "no profile — defaults";
    refs.refresh();
    void validateAllSlots();
  }

  async function saveProfile(): Promise<void> {
    if (state.loadedProfileId === null) {
      state.status = "no profile loaded — use 'save as…'";
      refs.refresh();
      return;
    }
    state.busy = true;
    refs.refresh();
    try {
      state.profiles = state.profiles.map((p) =>
        p.id === state.loadedProfileId ? { ...p, matrix: clone(state.matrix) } : p,
      );
      await persistProfiles();
      state.status = "profile saved";
    } catch (err) {
      state.status = `error saving profile: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  async function saveProfileAs(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      state.status = "the profile needs a name";
      refs.refresh();
      return;
    }
    state.busy = true;
    refs.refresh();
    try {
      const id = crypto.randomUUID() as LoopProfileId;
      const newProfile: LoopProfile = {
        id,
        name: trimmed,
        createdAt: Date.now(),
        matrix: clone(state.matrix),
      };
      state.profiles = [...state.profiles, newProfile];
      state.loadedProfileId = id;
      await persistProfiles();
      state.status = `profile "${trimmed}" saved`;
    } catch (err) {
      state.status = `error: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  async function persistProfiles(): Promise<void> {
    const payload: LoopProfilesState = {
      profiles: state.profiles,
      schemaVersion: 1,
    };
    queueSaveLoopProfiles(payload);
    await flushSaveLoopProfiles();
  }

  async function loadPromptBufferIfNeeded(name: LoopPromptName): Promise<void> {
    if (state.promptBuffers.has(name)) return;
    // Reserve the slot synchronously so concurrent calls don't all fire the tauri invoke.
    const fallback = state.globals.get(name) ?? "";
    state.promptBuffers.set(name, fallback);
    try {
      const content = await invoke<string>("loop_read_run_prompt", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        name,
      });
      // Empty string means the file does not exist yet — keep the global as the buffer.
      if (content !== "") {
        state.promptBuffers.set(name, content);
        refs.refresh();
      }
    } catch (err) {
      state.status = `could not read run prompt ${name}: ${stringifyError(err)}`;
      refs.refresh();
    }
  }

  async function ensureRunDir(): Promise<void> {
    try {
      await invoke<unknown>("loop_create_run", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
      });
    } catch (err) {
      const msg = stringifyError(err);
      if (!msg.includes("already exists")) throw err;
    }
  }

  async function resetToGlobal(name: LoopPromptName): Promise<void> {
    state.busy = true;
    state.status = "resetting to global…";
    refs.refresh();
    try {
      await ensureRunDir();
      if (disposed) return;
      const fresh = await invoke<string>("loop_read_global_prompt", { name });
      if (disposed) return;
      state.globals.set(name, fresh);
      state.promptBuffers.set(name, fresh);
      await invoke<void>("loop_reset_run_prompt_to_global", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        name,
      });
      if (disposed) return;
      state.status = `${name} reset to global`;
    } catch (err) {
      if (disposed) return;
      state.status = `error resetting: ${stringifyError(err)}`;
    } finally {
      if (!disposed) {
        state.busy = false;
        refs.refresh();
      }
    }
  }

  async function reseedFromBundled(name: LoopPromptName): Promise<void> {
    state.busy = true;
    state.status = "reseeding from bundled…";
    refs.refresh();
    try {
      await invoke<void>("loop_reseed_global_prompt", { name });
      if (disposed) return;
      await ensureRunDir();
      if (disposed) return;
      const fresh = await invoke<string>("loop_read_global_prompt", { name });
      if (disposed) return;
      state.globals.set(name, fresh);
      state.promptBuffers.set(name, fresh);
      await invoke<void>("loop_reset_run_prompt_to_global", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        name,
      });
      if (disposed) return;
      state.status = `${name} reseeded from bundled`;
    } catch (err) {
      if (disposed) return;
      state.status = `error reseeding: ${stringifyError(err)}`;
    } finally {
      if (!disposed) {
        state.busy = false;
        refs.refresh();
      }
    }
  }

  async function promoteToGlobal(name: LoopPromptName): Promise<void> {
    const content = state.promptBuffers.get(name) ?? "";
    state.busy = true;
    state.status = "saving as global default…";
    refs.refresh();
    try {
      await invoke<void>("loop_write_global_prompt", { name, content });
      state.globals.set(name, content);
      state.status = `${name} promoted to global default`;
    } catch (err) {
      state.status = `error promoting: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  async function validateSlot(role: LoopAgentRole): Promise<void> {
    const slot = state.matrix[role];
    if (disposed) return;
    state.validations.set(role, { ok: null, reason: "pending" });
    refs.refreshValidationsOnly();
    try {
      const v = await invoke<CliValidation>("loop_validate_cli_model", {
        cli: slot.cli,
        model: slot.model,
      });
      if (disposed) return;
      state.validations.set(role, v);
    } catch (err) {
      if (disposed) return;
      state.validations.set(role, { ok: false, reason: stringifyError(err) });
    }
    if (disposed) return;
    refs.refreshValidationsOnly();
  }

  async function validateAllSlots(): Promise<void> {
    await Promise.all(ALL_AGENT_ROLES.map((r) => validateSlot(r)));
  }

  async function executeRun(): Promise<void> {
    if (!canExecute(state)) {
      state.status = "there are invalid slots — fix them before running";
      refs.refresh();
      return;
    }
    // The scheduler reads `<run>/prompts/<name>` from disk for every agent invocation,
    // so inline edits must be flushed to the run dir before handing off.
    state.busy = true;
    state.status = "persisting prompts…";
    refs.refresh();
    const overrides: Partial<Record<LoopPromptName, string>> = {};
    try {
      await ensureRunDir();
      for (const name of LOOP_PROMPT_NAMES) {
        const buf = state.promptBuffers.get(name);
        if (buf === undefined) continue;
        await invoke<void>("loop_write_run_prompt", {
          projectPath: ctx.projectPath,
          runId: ctx.runId,
          name,
          content: buf,
        });
        const global = state.globals.get(name) ?? "";
        if (buf !== global) overrides[name] = buf;
      }
    } catch (err) {
      state.busy = false;
      state.status = `could not persist prompts: ${stringifyError(err)}`;
      refs.refresh();
      return;
    }
    state.busy = false;
    state.status = "";
    refs.refresh();

    const config: RunConfig = {
      mode: effectiveMode(state),
      matrix: clone(state.matrix),
      promptOverrides: overrides,
      config: { ...state.config },
    };
    if (ctx.onExecuteRun) {
      ctx.onExecuteRun(config);
    } else {
      state.status = "engine pending — no onExecuteRun handler";
      refs.refresh();
    }
  }

  return {
    dispose: () => {
      disposed = true;
      refs.cleanup();
    },
  };
}
