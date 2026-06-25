// Step 3 of the agentic flow: unified run setup.
//
// Step 3 gathers in a single view all the decisions prior to running:
// mode (sequential/hybrid), loaded profile, the 7 editable prompts with
// CLI/model per agent, slot validation, and the config row
// (retries, budget, on-fail). It aims to give the user visibility of all
// configuration before pressing "▶ run" (which Section 6 wires up but
// does not connect to the engine — Section 7+ wires it).
//
// Overall design (aligned with design.md, decision #10 "Inline UI in the
// Step 3 setup, not a separate settings page"):
// - Sidebar of the 7 prompts: 2 pre-phase (problem-intake / phase-decomposition)
//   informational + 5 agents (analysis / implementation / review / knowledge /
//   integration) with CLI/model dropdowns and validation.
// - Main panel: textarea of the selected prompt, "↑ reset to global" /
//   "↓ save as global default" buttons, CLI/model dropdowns (only for
//   the 5 agents), input/output description.
// - Live detection of `default` vs `modified` by comparing the textarea
//   against the global content.
// - Validation when loading a profile: invokes `loop_validate_cli_model`
//   per slot; invalid slots turn red and disable "▶ run".
//
// Follows the "imperative view with re-render via replaceChildren()" pattern
// of step1-chat / step2-phases. We don't introduce a framework. Exposes
// `mountStep3Setup(slot, ctx)` with `dispose()`.

import { invoke } from "@tauri-apps/api/core";

import {
  flushSaveLoopProfiles,
  loadLoopProfiles,
  queueSaveLoopProfiles,
} from "../../shared/persistence/loop-profiles-store";
import { promptModal } from "../../shared/ui/modal";

import { stringifyError } from "../../shared/errors";

import { createListenerBag } from "./shared/listener-bag";
import { topologicalBatches, parsePhasesManifest, type Phase } from "./step2-phases";
import {
  ALL_AGENT_ROLES,
  DEFAULT_AGENT_SLOT,
  LOOP_CLIS,
  LOOP_PROMPT_NAMES,
  createDefaultMatrix,
  defaultModelFor,
  promptBlurb,
  promptToRole,
} from "./state/types";
import type {
  AgentSlot,
  CliValidation,
  LoopAgentRole,
  LoopCli,
  LoopProfile,
  LoopProfileId,
  LoopPromptName,
  LoopProfilesState,
  ProfileMatrix,
} from "./state/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Step3Context {
  /** Absolute path of the active project. */
  projectPath: string;
  /** Readable name of the project (shown in the top bar). */
  projectName: string;
  /** Suggested CLI of the project (active chip from the workspace). */
  suggestedCli: string | null;
  /** UUID of the current run. */
  runId: string;
  /**
   * Callback when the user presses "▶ run". Section 6 leaves the button
   * wired and validation working; the scheduler wiring lives in Section
   * 7 (sequential engine) — for now the callback is optional; if not passed
   * the button shows a message "engine pending (Section 7+)".
   */
  onExecuteRun?: (config: RunConfig) => void;
}

export interface Step3Handle {
  dispose(): void;
}

/** Execution mode of the run. */
export type RunMode = "sequential" | "hybrid";

/**
 * On-fail behavior. Read-only in this iteration — design.md decision #4
 * fixes "reviewer cap of 3 with warning propagation". We keep it as a
 * union so Section 7 can extend it without touching the shape.
 */
export type OnFailBehavior = "propagate-warning";

/**
 * Final snapshot the "▶ run" button passes to the engine. Section 7
 * consumes this.
 */
export interface RunConfig {
  mode: RunMode;
  matrix: ProfileMatrix;
  /**
   * Override per prompt: for each of the 7 prompts, run-edited content
   * (vs. the copy from the global). Only the modified ones appear here —
   * Section 7 uses the global by default.
   */
  promptOverrides: Partial<Record<LoopPromptName, string>>;
  config: {
    maxRetries: number;
    onFail: OnFailBehavior;
  };
}

type SlotValidation = CliValidation | { ok: null; reason: "pending" };

/** Internal state of the setup. */
interface Step3State {
  /** Profiles loaded from `profiles.json`. */
  profiles: LoopProfile[];
  /** Id of the profile loaded in the UI (null = "no profile — all claude/opus-4-7"). */
  loadedProfileId: LoopProfileId | null;
  /** Current editable matrix (independent of `loadedProfileId` — hydrated from it on load). */
  matrix: ProfileMatrix;
  /** Execution mode chosen by the user. */
  mode: RunMode;
  /** Prompt selected in the sidebar. */
  selectedPrompt: LoopPromptName;
  /**
   * Editable buffers of the prompt textarea, indexed by name. If the entry
   * exists, that is the content on screen; if not, we read from the run file
   * and memoize it here.
   */
  promptBuffers: Map<LoopPromptName, string>;
  /** Content of the globals in memory, to compare default vs modified. */
  globals: Map<LoopPromptName, string>;
  /** Validations per slot (only applies to the 5 agents). */
  validations: Map<LoopAgentRole, SlotValidation>;
  /** Config row. `maxRetries` and `onFail` are read-only by design. */
  config: {
    maxRetries: number;
    onFail: OnFailBehavior;
  };
  /** Status message shown in the top bar (e.g. "profile saved", error). */
  status: string | null;
  /** If we are validating, saving or running, disables controls. */
  busy: boolean;
  /** Run phases, read from 02-phases.md, to detect "all linear". */
  phases: Phase[];
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

  const refs = render(slot, state, ctx, (action) => {
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
        loadPromptBufferIfNeeded(action.name);
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
        executeRun();
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
    // The store's debounce already covers bursts; here we ask for confirmation.
    await flushSaveLoopProfiles();
  }

  function loadPromptBufferIfNeeded(name: LoopPromptName): void {
    if (state.promptBuffers.has(name)) return;
    // Try to read the run override; if it doesn't exist, fall back to global.
    // The run override for prompts lives at `<run>/prompts/<name>` —
    // but `loop_read_run_file` doesn't expose the prompt files (restricted
    // allowlist). Instead, we read directly from the global —
    // run buffers aren't yet edited in step3 (Section 7 extends this if
    // needed). In the meantime, the buffer starts equal to the global.
    state.promptBuffers.set(name, state.globals.get(name) ?? "");
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

  function executeRun(): void {
    if (!canExecute(state)) {
      state.status = "there are invalid slots — fix them before running";
      refs.refresh();
      return;
    }
    const overrides: Partial<Record<LoopPromptName, string>> = {};
    for (const name of LOOP_PROMPT_NAMES) {
      const buf = state.promptBuffers.get(name);
      const global = state.globals.get(name) ?? "";
      if (buf !== undefined && buf !== global) {
        overrides[name] = buf;
      }
    }
    const config: RunConfig = {
      mode: effectiveMode(state),
      matrix: clone(state.matrix),
      promptOverrides: overrides,
      config: { ...state.config },
    };
    if (ctx.onExecuteRun) {
      ctx.onExecuteRun(config);
    } else {
      // Section 7+ will pass the callback. Meanwhile, leave clear feedback.
      state.status = "engine pending — Section 7 wires the run scheduler";
      refs.refresh();
    }
  }

  return {
    dispose: () => {
      refs.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Step3Action =
  | { kind: "set-mode"; mode: RunMode }
  | { kind: "load-profile"; id: LoopProfileId | null }
  | { kind: "save-profile" }
  | { kind: "save-profile-as"; name: string }
  | { kind: "set-slot"; role: LoopAgentRole; cli: LoopCli; model: string }
  | { kind: "select-prompt"; name: LoopPromptName }
  | { kind: "set-prompt-buffer"; name: LoopPromptName; value: string }
  | { kind: "reset-to-global"; name: LoopPromptName }
  | { kind: "promote-to-global"; name: LoopPromptName }
  | { kind: "execute" };

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

interface ViewRefs {
  refresh(): void;
  refreshValidationsOnly(): void;
  cleanup(): void;
}

function render(
  slot: HTMLElement,
  state: Step3State,
  ctx: Step3Context,
  dispatch: (action: Step3Action) => void,
): ViewRefs {
  slot.classList.add("loop-step3");

  const root = document.createElement("div");
  root.className = "loop-step3-root";
  slot.replaceChildren(root);

  const listeners = createListenerBag();
  const { on } = listeners;

  function refresh(): void {
    root.replaceChildren();
    root.append(renderTopBar(), renderBody(), renderFooter());
  }

  function refreshValidationsOnly(): void {
    // Re-renders the sidebar (where validation badges are shown) and the
    // footer row (where the ▶ button depends on validation). We avoid
    // re-rendering the textarea to not lose the caret.
    const sidebar = root.querySelector(".loop-step3-sidebar");
    if (sidebar) sidebar.replaceWith(renderSidebar());
    const footer = root.querySelector(".loop-step3-footer");
    if (footer) footer.replaceWith(renderFooter());
    // The agent main panel also shows the CLI/model dropdowns with a red
    // border when validation fails.
    const mainSlot = root.querySelector(".loop-step3-main-validation");
    if (mainSlot) mainSlot.replaceWith(renderMainValidationRow(state.selectedPrompt));
  }

  function cleanup(): void {
    listeners.dispose();
    slot.classList.remove("loop-step3");
  }

  // -------------------------------------------------------------------------
  // Top bar
  // -------------------------------------------------------------------------

  function renderTopBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "loop-step3-topbar";

    const left = document.createElement("div");
    left.className = "loop-step3-topbar-left";
    const proj = document.createElement("span");
    proj.className = "loop-step3-topbar-project";
    proj.textContent = ctx.projectName;
    proj.title = ctx.projectPath;
    const sep = document.createElement("span");
    sep.className = "loop-step3-topbar-sep";
    sep.textContent = "·";
    const cli = document.createElement("span");
    cli.className = "loop-step3-topbar-cli";
    cli.textContent = ctx.suggestedCli ? `suggested CLI: ${ctx.suggestedCli}` : "no suggested CLI";
    left.append(proj, sep, cli);

    const center = document.createElement("div");
    center.className = "loop-step3-topbar-center";
    center.append(renderModeSelector(), renderProfileBlock());

    const right = document.createElement("div");
    right.className = "loop-step3-topbar-right";
    if (state.status) {
      const s = document.createElement("span");
      s.className = "loop-step3-topbar-status";
      if (state.status.startsWith("error")) {
        s.classList.add("loop-step3-topbar-status-error");
      }
      s.textContent = state.status;
      right.append(s);
    }

    bar.append(left, center, right);
    return bar;
  }

  function renderModeSelector(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step3-mode";

    const lbl = document.createElement("span");
    lbl.className = "loop-step3-mode-label";
    lbl.textContent = "mode";

    const group = document.createElement("div");
    group.className = "loop-step3-mode-group";
    for (const mode of ["sequential", "hybrid"] as const) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "loop-step3-mode-btn";
      if (mode === state.mode) btn.classList.add("loop-step3-mode-btn-active");
      btn.textContent = mode === "sequential" ? "sequential" : "hybrid";
      btn.disabled = state.busy;
      on(btn, "click", () => dispatch({ kind: "set-mode", mode }));
      group.appendChild(btn);
    }
    wrap.append(lbl, group);

    // "Parallel mode equivalent to sequential" detection — when all
    // phases are in lanes of 1, hybrid degrades to sequential. We show it
    // as a hint when the user chose hybrid.
    if (state.mode === "hybrid" && state.phases.length > 0) {
      const batches = topologicalBatches(state.phases);
      if (batches && batches.every((b) => b.length === 1)) {
        const hint = document.createElement("span");
        hint.className = "loop-step3-mode-hint";
        hint.textContent = "(hybrid ≡ sequential: linear DAG)";
        wrap.appendChild(hint);
      }
    }

    return wrap;
  }

  function renderProfileBlock(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step3-profile";

    const lbl = document.createElement("span");
    lbl.className = "loop-step3-profile-label";
    lbl.textContent = "profile";

    const sel = document.createElement("select");
    sel.className = "loop-step3-profile-select";
    sel.disabled = state.busy;
    sel.setAttribute("aria-label", "CLI/model matrix profile");
    const optNone = document.createElement("option");
    optNone.value = "";
    // Section 10.4 — empty state when there are no saved profiles. The hint
    // inside the placeholder tells the user they can create the first
    // profile with "save as…".
    optNone.textContent =
      state.profiles.length === 0
        ? "— no saved profiles (use 'save as…') —"
        : "— no profile (defaults) —";
    if (state.loadedProfileId === null) optNone.selected = true;
    sel.appendChild(optNone);
    for (const p of state.profiles) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      if (p.id === state.loadedProfileId) o.selected = true;
      sel.appendChild(o);
    }
    on(sel, "change", () => {
      const v = sel.value;
      const id: LoopProfileId | null = v ? (v as LoopProfileId) : null;
      dispatch({ kind: "load-profile", id });
    });

    const save = document.createElement("button");
    save.type = "button";
    save.className = "loop-btn loop-btn-ghost";
    save.textContent = "save";
    save.disabled = state.busy || state.loadedProfileId === null;
    save.title =
      state.loadedProfileId === null
        ? "Load a profile first or use 'save as…'"
        : "Overwrites the loaded profile with the current matrix";
    on(save, "click", () => dispatch({ kind: "save-profile" }));

    const saveAs = document.createElement("button");
    saveAs.type = "button";
    saveAs.className = "loop-btn loop-btn-ghost";
    saveAs.textContent = "save as…";
    saveAs.disabled = state.busy;
    on(saveAs, "click", () => {
      // Section 10.2 — replaces window.prompt with the styled modal from
      // shared/ui. The modal uses Enter to confirm and Esc to cancel.
      void (async () => {
        const name = await promptModal({
          title: "Save profile",
          message: "Profile name (saved in profiles.json, local to this machine).",
          placeholder: "e.g. claude-only",
          confirmLabel: "save",
          cancelLabel: "cancel",
        });
        if (name !== null) dispatch({ kind: "save-profile-as", name });
      })();
    });

    wrap.append(lbl, sel, save, saveAs);
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Body (sidebar + main)
  // -------------------------------------------------------------------------

  function renderBody(): HTMLElement {
    const body = document.createElement("div");
    body.className = "loop-step3-body";
    body.append(renderSidebar(), renderMain());
    return body;
  }

  function renderSidebar(): HTMLElement {
    const aside = document.createElement("aside");
    aside.className = "loop-step3-sidebar";

    const head = document.createElement("div");
    head.className = "loop-step3-sidebar-head";
    head.textContent = "Run prompts";
    aside.appendChild(head);

    const list = document.createElement("ul");
    list.className = "loop-step3-prompt-list";

    // Group: pre-phases (2)
    const preHeading = document.createElement("li");
    preHeading.className = "loop-step3-prompt-section";
    preHeading.textContent = "Pre-phases";
    list.appendChild(preHeading);
    for (const name of LOOP_PROMPT_NAMES.slice(0, 2)) {
      list.appendChild(renderPromptItem(name));
    }

    // Group: agents (5)
    const agentHeading = document.createElement("li");
    agentHeading.className = "loop-step3-prompt-section";
    agentHeading.textContent = "Step 3 agents";
    list.appendChild(agentHeading);
    for (const name of LOOP_PROMPT_NAMES.slice(2)) {
      list.appendChild(renderPromptItem(name));
    }

    aside.appendChild(list);
    return aside;
  }

  function renderPromptItem(name: LoopPromptName): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "loop-step3-prompt-item";
    if (name === state.selectedPrompt) item.classList.add("loop-step3-prompt-item-active");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "loop-step3-prompt-btn";
    btn.disabled = state.busy;
    on(btn, "click", () => dispatch({ kind: "select-prompt", name }));

    const titleRow = document.createElement("div");
    titleRow.className = "loop-step3-prompt-title-row";
    const title = document.createElement("span");
    title.className = "loop-step3-prompt-title";
    title.textContent = name;
    titleRow.appendChild(title);

    const badge = document.createElement("span");
    badge.className = "loop-step3-prompt-badge";
    const modified = isPromptModified(state, name);
    if (modified) {
      badge.classList.add("loop-step3-prompt-badge-modified");
      badge.textContent = "modified";
    } else {
      badge.classList.add("loop-step3-prompt-badge-default");
      badge.textContent = "default";
    }
    titleRow.appendChild(badge);

    btn.appendChild(titleRow);

    // Bottom line: CLI/model (only for agents) + validation tick.
    const role = promptToRole(name);
    if (role) {
      const meta = document.createElement("div");
      meta.className = "loop-step3-prompt-meta";
      const slot = state.matrix[role];
      const text = document.createElement("span");
      text.className = "loop-step3-prompt-cli";
      text.textContent = `${slot.cli} · ${slot.model}`;
      meta.appendChild(text);

      const v = state.validations.get(role);
      const dot = document.createElement("span");
      dot.className = "loop-step3-prompt-dot";
      if (!v) {
        dot.classList.add("loop-step3-prompt-dot-unknown");
        dot.title = "not validated";
      } else if ("ok" in v && v.ok === null) {
        dot.classList.add("loop-step3-prompt-dot-pending");
        dot.title = "validating…";
      } else if (v.ok === true) {
        dot.classList.add("loop-step3-prompt-dot-ok");
        dot.title = "CLI and model valid";
      } else {
        dot.classList.add("loop-step3-prompt-dot-error");
        dot.title = v.reason ?? "invalid";
      }
      meta.appendChild(dot);
      btn.appendChild(meta);
    } else {
      const meta = document.createElement("div");
      meta.className = "loop-step3-prompt-meta";
      const text = document.createElement("span");
      text.className = "loop-step3-prompt-cli loop-step3-prompt-cli-muted";
      text.textContent = "(used in step 1/2)";
      meta.appendChild(text);
      btn.appendChild(meta);
    }

    item.appendChild(btn);
    return item;
  }

  // -------------------------------------------------------------------------
  // Main panel
  // -------------------------------------------------------------------------

  function renderMain(): HTMLElement {
    const main = document.createElement("section");
    main.className = "loop-step3-main";
    const name = state.selectedPrompt;
    main.append(
      renderMainHeader(name),
      renderMainValidationRow(name),
      renderMainEditor(name),
      renderMainEditorToolbar(name),
    );
    return main;
  }

  function renderMainHeader(name: LoopPromptName): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step3-main-header";

    const blurb = promptBlurb(name);
    const title = document.createElement("div");
    title.className = "loop-step3-main-title";
    title.textContent = blurb.title;
    const io = document.createElement("div");
    io.className = "loop-step3-main-io";
    io.textContent = blurb.io;

    wrap.append(title, io);
    return wrap;
  }

  /**
   * CLI/model dropdowns + red mark if validation failed. For pre-phase
   * prompts (which don't have an agent role) we show an explanatory note.
   */
  function renderMainValidationRow(name: LoopPromptName): HTMLElement {
    const row = document.createElement("div");
    row.className = "loop-step3-main-validation";

    const role = promptToRole(name);
    if (!role) {
      const note = document.createElement("p");
      note.className = "loop-step3-main-validation-note";
      note.textContent =
        name === "problem-intake.md"
          ? "The intake CLI/model is chosen in Step 1. Here you only edit the agent prompt."
          : "The decomposition CLI/model is chosen in Step 2. Here you only edit the agent prompt.";
      row.appendChild(note);
      return row;
    }

    const slot = state.matrix[role];
    const v = state.validations.get(role);
    const failed = v && "ok" in v && v.ok === false;

    const cliWrap = document.createElement("label");
    cliWrap.className = "loop-step3-main-field";
    const cliLbl = document.createElement("span");
    cliLbl.className = "loop-step3-main-field-label";
    cliLbl.textContent = "CLI";
    const cliSel = document.createElement("select");
    cliSel.className = "loop-step3-main-field-select";
    if (failed) cliSel.classList.add("loop-step3-main-field-select-error");
    cliSel.disabled = state.busy;
    for (const c of LOOP_CLIS) {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      if (c === slot.cli) o.selected = true;
      cliSel.appendChild(o);
    }
    on(cliSel, "change", () => {
      const nextCli = cliSel.value as LoopCli;
      // When the CLI changes, we reset the model to the default of the new CLI
      // to avoid leaving `opus-4-7` pointing at codex (which doesn't know it).
      const nextModel = slot.cli === nextCli ? slot.model : defaultModelFor(nextCli);
      dispatch({
        kind: "set-slot",
        role,
        cli: nextCli,
        model: nextModel,
      });
    });
    cliWrap.append(cliLbl, cliSel);

    const modelWrap = document.createElement("label");
    modelWrap.className = "loop-step3-main-field";
    const modelLbl = document.createElement("span");
    modelLbl.className = "loop-step3-main-field-label";
    modelLbl.textContent = "model";
    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.className = "loop-step3-main-field-input";
    if (failed) modelInput.classList.add("loop-step3-main-field-input-error");
    modelInput.value = slot.model;
    modelInput.disabled = state.busy;
    on(modelInput, "change", () => {
      dispatch({
        kind: "set-slot",
        role,
        cli: slot.cli,
        model: modelInput.value.trim() || DEFAULT_AGENT_SLOT.model,
      });
    });
    modelWrap.append(modelLbl, modelInput);

    row.append(cliWrap, modelWrap);

    if (failed) {
      const err = document.createElement("span");
      err.className = "loop-step3-main-validation-error";
      err.textContent = v?.reason ?? "invalid";
      row.appendChild(err);
    } else if (v && "ok" in v && v.ok === null) {
      const pending = document.createElement("span");
      pending.className = "loop-step3-main-validation-pending";
      pending.textContent = "validating…";
      row.appendChild(pending);
    } else if (v && "ok" in v && v.ok === true) {
      const okEl = document.createElement("span");
      okEl.className = "loop-step3-main-validation-ok";
      okEl.textContent = "✓";
      row.appendChild(okEl);
    }

    return row;
  }

  function renderMainEditor(name: LoopPromptName): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step3-main-editor-wrap";
    const content = state.promptBuffers.get(name) ?? state.globals.get(name) ?? "";
    const ta = document.createElement("textarea");
    ta.className = "loop-step3-main-editor";
    ta.spellcheck = false;
    ta.value = content;
    ta.disabled = state.busy;
    ta.placeholder = "Prompt content (markdown). Cmd+S to promote to global.";
    ta.setAttribute("aria-label", `editor for prompt ${name} — Cmd+S saves as global default`);
    on(ta, "input", () => {
      dispatch({ kind: "set-prompt-buffer", name, value: ta.value });
    });
    // Section 10.3 — Cmd+S promotes the current buffer to global. If there
    // are no changes vs. global, the dispatch is a no-op (promote-to-global
    // detects the case). We keep the event scoped to the textarea so it
    // doesn't clash with other editors in the module.
    on(ta, "keydown", (e: KeyboardEvent) => {
      if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (state.busy || !isPromptModified(state, name)) return;
        dispatch({ kind: "promote-to-global", name });
      }
    });
    wrap.appendChild(ta);
    return wrap;
  }

  function renderMainEditorToolbar(name: LoopPromptName): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "loop-step3-main-toolbar";

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "loop-btn loop-btn-ghost";
    reset.textContent = "↑ reset to global";
    reset.disabled = state.busy || !isPromptModified(state, name);
    reset.title = "Discards changes in this run and returns to the global content";
    on(reset, "click", () => dispatch({ kind: "reset-to-global", name }));

    const promote = document.createElement("button");
    promote.type = "button";
    promote.className = "loop-btn loop-btn-ghost";
    promote.textContent = "↓ save as global default";
    promote.disabled = state.busy || !isPromptModified(state, name);
    promote.title = "Overwrites the global with the current content — affects future runs";
    on(promote, "click", () => dispatch({ kind: "promote-to-global", name }));

    bar.append(reset, promote);
    return bar;
  }

  // -------------------------------------------------------------------------
  // Footer
  // -------------------------------------------------------------------------

  function renderFooter(): HTMLElement {
    const f = document.createElement("div");
    f.className = "loop-step3-footer";

    const config = document.createElement("div");
    config.className = "loop-step3-config-row";

    // max retries (read-only)
    const retriesWrap = document.createElement("label");
    retriesWrap.className = "loop-step3-config-field";
    const retriesLbl = document.createElement("span");
    retriesLbl.className = "loop-step3-config-label";
    retriesLbl.textContent = "max retries";
    const retriesInput = document.createElement("input");
    retriesInput.type = "number";
    retriesInput.value = String(state.config.maxRetries);
    retriesInput.readOnly = true;
    retriesInput.disabled = true;
    retriesInput.className = "loop-step3-config-input loop-step3-config-input-readonly";
    retriesInput.title = "design.md decision #4: fixed cap of 3 with propagated warning";
    retriesWrap.append(retriesLbl, retriesInput);

    // on-fail (read-only)
    const onFailWrap = document.createElement("label");
    onFailWrap.className = "loop-step3-config-field";
    const onFailLbl = document.createElement("span");
    onFailLbl.className = "loop-step3-config-label";
    onFailLbl.textContent = "on fail";
    const onFailInput = document.createElement("input");
    onFailInput.type = "text";
    onFailInput.value = "propagate warning";
    onFailInput.readOnly = true;
    onFailInput.disabled = true;
    onFailInput.className = "loop-step3-config-input loop-step3-config-input-readonly";
    onFailInput.title = "design.md decision #4: propagate warning to knowledge";
    onFailWrap.append(onFailLbl, onFailInput);

    config.append(retriesWrap, onFailWrap);

    const exec = document.createElement("button");
    exec.type = "button";
    exec.className = "loop-btn loop-btn-primary loop-step3-execute";
    const allowed = canExecute(state);
    exec.disabled = !allowed;
    const invalid = countInvalidSlots(state);
    if (invalid > 0) {
      exec.title = `${invalid} invalid slot(s) — fix them before running`;
    } else if (state.busy) {
      exec.title = "waiting for validation to finish";
    } else {
      exec.title = "Runs the run with the current configuration";
    }
    exec.textContent = "▶ run";
    on(exec, "click", () => dispatch({ kind: "execute" }));

    f.append(config, exec);
    return f;
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  refresh();

  return {
    refresh,
    refreshValidationsOnly,
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (also exported for future tests and Section 7)
// ---------------------------------------------------------------------------

/** Does the prompt buffer differ from the global loaded in memory? */
export function isPromptModified(state: Step3State, name: LoopPromptName): boolean {
  const buf = state.promptBuffers.get(name);
  if (buf === undefined) return false; // not loaded yet
  return buf !== (state.globals.get(name) ?? "");
}

/**
 * If the mode is hybrid but all phases fall into lanes of 1, the engine
 * degrades to sequential. This function returns the "effective" mode the
 * scheduler will use — Section 7+ should respect it.
 */
export function effectiveMode(state: Step3State): RunMode {
  if (state.mode !== "hybrid") return state.mode;
  if (state.phases.length === 0) return "hybrid";
  const batches = topologicalBatches(state.phases);
  if (!batches) return state.mode;
  return batches.every((b) => b.length === 1) ? "sequential" : "hybrid";
}

/** Number of slots with failed validation (excluding "pending"). */
export function countInvalidSlots(state: Step3State): number {
  let n = 0;
  for (const role of ALL_AGENT_ROLES) {
    const v = state.validations.get(role);
    if (v && "ok" in v && v.ok === false) n += 1;
  }
  return n;
}

/** Is the setup well-formed to run? Validations loaded and all ok. */
export function canExecute(state: Step3State): boolean {
  if (state.busy) return false;
  if (state.phases.length === 0) return false;
  for (const role of ALL_AGENT_ROLES) {
    const v = state.validations.get(role);
    if (!v) return false;
    if ("ok" in v && v.ok !== true) return false;
  }
  return true;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
