// Step 3 of the agentic flow: unified run setup.
//
// Step 3 gathers in a single view all the decisions prior to running:
// mode (sequential/hybrid), loaded profile, the 7 editable prompts with
// CLI/model per agent, slot validation, and the config row (retries,
// budget, on-fail). It aims to give the user visibility of all
// configuration before pressing "▶ run".
//
// Overall design (aligned with design.md, decision #10 "Inline UI in the
// Step 3 setup, not a separate settings page"):
// - Sidebar of the 7 prompts: 2 pre-phase (problem-intake /
//   phase-decomposition) informational + 5 agents (analysis /
//   implementation / review / knowledge / integration) with CLI/model
//   dropdowns and validation.
// - Main panel: textarea of the selected prompt, "↑ reset to global" /
//   "↓ save as global default" buttons, CLI/model dropdowns (only for
//   the 5 agents), input/output description.
// - Live detection of `default` vs `modified` by comparing the textarea
//   against the global content.
// - Validation when loading a profile: invokes `loop_validate_cli_model`
//   per slot; invalid slots turn red and disable "▶ run".
//
// Follows the "imperative view with re-render via replaceChildren()"
// pattern of step1-chat / step2-phases. The renderer lives in
// `./step3-setup/view.ts`; pure selectors in `./step3-setup/helpers.ts`;
// this file owns the state machine and the side effects (profile
// persistence, slot validation, prompt I/O).

import { invoke } from "@tauri-apps/api/core";

import {
  flushSaveLoopProfiles,
  loadLoopProfiles,
  queueSaveLoopProfiles,
} from "../../shared/persistence/loop-profiles-store";
import { stringifyError } from "../../shared/errors";

import { parsePhasesManifest } from "./step2-phases";
import { ALL_AGENT_ROLES, LOOP_PROMPT_NAMES, createDefaultMatrix } from "./state/types";
import type {
  AgentSlot,
  CliValidation,
  LoopAgentRole,
  LoopProfile,
  LoopProfileId,
  LoopProfilesState,
  LoopPromptName,
} from "./state/types";

import { canExecute, clone, effectiveMode } from "./step3-setup/helpers";
import type {
  RunConfig,
  RunMode,
  Step3Action,
  Step3Context,
  Step3State,
} from "./step3-setup/state";
import { renderView } from "./step3-setup/view";

export type { RunConfig, RunMode, Step3Context };
export {
  canExecute,
  countInvalidSlots,
  effectiveMode,
  isPromptModified,
} from "./step3-setup/helpers";

export interface Step3Handle {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

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

  const refs = renderView(slot, state, ctx, (action) => {
    void handleAction(action);
  });

  // Initial hydration: profiles, globals, run phases.
  void hydrate();

  async function hydrate(): Promise<void> {
    state.busy = true;
    state.status = "loading configuration…";
    refs.refresh();
    try {
      // Ensure the global prompts dir exists (idempotent).
      await invoke<string[]>("loop_ensure_prompts_dir").catch(() => []);

      const profilesState = await loadLoopProfiles();
      state.profiles = profilesState.profiles;

      // Load the 7 globals in parallel — they are small files.
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
      state.globals = new Map(globalsEntries);

      // Run phases for the "hybrid ≡ sequential" detection.
      try {
        const manifest = await invoke<string>("loop_read_run_file", {
          projectPath: ctx.projectPath,
          runId: ctx.runId,
          file: "02-phases.md",
        });
        state.phases = manifest.trim() ? parsePhasesManifest(manifest) : [];
      } catch {
        state.phases = [];
      }

      state.status = null;
    } catch (err) {
      state.status = `error loading: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
      // Trigger default slot validation — they can be invalid CLI/model
      // even if the user hasn't loaded a profile.
      void validateAllSlots();
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
        // Re-render to update the default/modified badge in the sidebar.
        refs.refresh();
        return;
      case "reset-to-global": {
        const content = state.globals.get(action.name) ?? "";
        state.promptBuffers.set(action.name, content);
        refs.refresh();
        return;
      }
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
    // Force flush before the toast says "saved" so the user doesn't get
    // surprised by a profile that doesn't appear if they close quickly.
    // The store's debounce already covers bursts; here we ask for
    // confirmation.
    await flushSaveLoopProfiles();
  }

  async function loadPromptBufferIfNeeded(name: LoopPromptName): Promise<void> {
    if (state.promptBuffers.has(name)) return;
    // Reserve the slot synchronously so concurrent calls don't all fire
    // the tauri invoke. We'll overwrite with the disk content once it
    // lands.
    const fallback = state.globals.get(name) ?? "";
    state.promptBuffers.set(name, fallback);
    try {
      const content = await invoke<string>("loop_read_run_prompt", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        name,
      });
      // Empty string means the file does not exist yet — keep the global
      // as the buffer so first-time editors don't start from a blank
      // slate.
      if (content !== "") {
        state.promptBuffers.set(name, content);
        refs.refresh();
      }
    } catch (err) {
      // The run dir should always be there at this point (loop_create_run
      // runs before Step 3 mounts), so this is unexpected — surface it.
      state.status = `could not read run prompt ${name}: ${stringifyError(err)}`;
      refs.refresh();
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
    state.validations.set(role, { ok: null, reason: "pending" });
    refs.refreshValidationsOnly();
    try {
      const v = await invoke<CliValidation>("loop_validate_cli_model", {
        cli: slot.cli,
        model: slot.model,
      });
      state.validations.set(role, v);
    } catch (err) {
      state.validations.set(role, { ok: false, reason: stringifyError(err) });
    }
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
    // The scheduler reads `<run>/prompts/<name>` from disk for every
    // agent invocation. Flush all inline edits to the run dir BEFORE
    // handing off, otherwise the in-memory buffer is silently dropped
    // (the old behavior built a `promptOverrides` map that nothing
    // downstream consumed).
    state.busy = true;
    state.status = "persisting prompts…";
    refs.refresh();
    const overrides: Partial<Record<LoopPromptName, string>> = {};
    try {
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
      // Hook left for callers that want to inspect setup without
      // launching the scheduler. The chrome always wires onExecuteRun.
      state.status = "engine pending — no onExecuteRun handler";
      refs.refresh();
    }
  }

  return {
    dispose: () => {
      refs.cleanup();
    },
  };
}
