// Step 2 of the agentic flow: phase decomposition with inline editor.
//
// Overall design (aligned with design.md, decision #2 "parallel mode with
// topological sort"):
// - Step 2 takes `<run>/01-problem.md` and, via the agent with
//   `phase-decomposition.md` as system prompt, receives a JSON with the list
//   of phases. The JSON is validated and persisted as `02-phases.md` (a fence
//   with the JSON; we use .md for consistency with the rest of the run, but
//   the parseable content is the JSON inside the fence or the whole document
//   if it is clean).
// - Each phase has a subdir at `<run>/phases/<NN>-<slug>/` with `logic.md`
//   (always) and optionally `visual.html` (when `hasVisual=true`).
// - The UI: phase sidebar with badges and dependencies + main panel with
//   tabs (logic.md / visual.html) + editable textarea + toolbar (save,
//   "✨ edit with AI"). dependsOn editor as multi-select. Read-only topology
//   view below the sidebar.
//
// Editor choice: styled textarea (NOT Monaco). Reasons:
// 1. Monaco is not in deps (`package.json:25-44`); adding it would
//    significantly increase the /loop bundle.
// 2. Editing here is light markdown / simple HTML; a textarea with
//    monospace + generous line height is enough for the step 2 scope.
// 3. The AI editor (selection + instruction → applied diff) uses the
//    standard DOM selection API — works in a textarea without extras.
//
// Follows the "imperative view with re-render via replaceChildren()" pattern
// from step1-chat. Exposes `mountStep2Phases(slot, ctx)` with `dispose()`.

import { invoke } from "@tauri-apps/api/core";

import { stringifyError } from "../../shared/errors";
import { createListenerBag } from "./shared/listener-bag";
import { buildRunPromptPath, defaultModelFor, LOOP_CLIS, type LoopCli } from "./state/types";
import { detectCycle, phaseSlug, slugToId, topologicalBatches } from "./step2-phases/graph";
import {
  parseAgentPhasesJson,
  parsePhasesManifest,
  serializePhasesManifest,
  stripCodeFence,
  type PhaseDraft,
} from "./step2-phases/manifest";

// Re-export the helpers and PhaseDraft so existing consumers (loop-chrome,
// step3-setup, run-scheduler) keep importing from `./step2-phases`.
export {
  detectCycle,
  parseAgentPhasesJson,
  parsePhasesManifest,
  phaseSlug,
  serializePhasesManifest,
  topologicalBatches,
};
export type { PhaseDraft };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A step 2 phase according to the agent's JSON. */
export interface Phase {
  id: string;
  name: string;
  summary?: string;
  dependsOn: string[];
  hasVisual: boolean;
}

/** Normalized result from `run_loop_agent` (same shape as step1-chat). */
interface AgentResult {
  text: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  sessionId?: string | null;
  error?: string | null;
}

/** Disk state of a phase returned by `loop_list_phase_dirs`. */
interface PhaseDirStatus {
  slug: string;
  hasLogic: boolean;
  hasVisual: boolean;
}

export interface Step2Context {
  /** Absolute path of the active project. */
  projectPath: string;
  /** UUID of the current run. */
  runId: string;
  /** Callback when the user clicks "→ Step 3". Validated: all phases have logic.md. */
  onAdvance: () => void;
}

export interface Step2Handle {
  dispose(): void;
}

type FileTab = "logic.md" | "visual.html";

interface Step2State {
  /** List of phases ordered by id (1..N). */
  phases: Phase[];
  /** Slug of the phase selected in the sidebar, or null if none. */
  selectedSlug: string | null;
  /** Active tab of the main panel. */
  activeTab: FileTab;
  /** Disk state per slug — which files are materialized. */
  diskStatus: Map<string, PhaseDirStatus>;
  /** Editor buffer content (not saved yet) — keyed by `${slug}:${tab}`. */
  editorBuffers: Map<string, string>;
  /** Set of `${slug}:${tab}` keys with unsaved changes. */
  dirty: Set<string>;
  /** CLI chosen to invoke the step 2 agent / AI editing. */
  cli: LoopCli;
  /** Status message shown in the header (e.g. "saved", "generating…", error). */
  status: string | null;
  /** If we are generating phases or invoking AI, disables controls. */
  busy: boolean;
  /** Manifest validation error (cycles detected, etc.). */
  cycleError: string | null;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountStep2Phases(slot: HTMLElement, ctx: Step2Context): Step2Handle {
  const state: Step2State = {
    phases: [],
    selectedSlug: null,
    activeTab: "logic.md",
    diskStatus: new Map(),
    editorBuffers: new Map(),
    dirty: new Set(),
    cli: "claude",
    status: null,
    busy: false,
    cycleError: null,
  };

  const refs: ViewRefs = render(slot, state, ctx, (action) => {
    void handleAction(action);
  });

  // Bootstrap: read manifest from disk if it exists; otherwise stays empty
  // until the user clicks "regenerate from 01-problem.md".
  void hydrate();

  async function hydrate(): Promise<void> {
    try {
      const manifest = await invoke<string>("loop_read_run_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        file: "02-phases.md",
      });
      if (manifest.trim()) {
        const phases = parsePhasesManifest(manifest);
        if (phases.length > 0) {
          state.phases = phases;
          state.selectedSlug = phaseSlug(phases[0]);
        }
      }
    } catch {
      // No manifest yet — empty initial state.
    }
    await refreshDiskStatus();
    refs.refresh();
  }

  async function refreshDiskStatus(): Promise<void> {
    try {
      const list = await invoke<PhaseDirStatus[]>("loop_list_phase_dirs", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
      });
      state.diskStatus = new Map(list.map((s) => [s.slug, s]));
    } catch {
      // If phases/ does not exist, we treat it as empty.
      state.diskStatus = new Map();
    }
  }

  async function handleAction(action: Step2Action): Promise<void> {
    switch (action.kind) {
      case "set-cli":
        state.cli = action.cli;
        refs.refresh();
        return;
      case "select-phase":
        state.selectedSlug = action.slug;
        state.activeTab = "logic.md";
        await loadBufferIfNeeded(action.slug, "logic.md");
        refs.refresh();
        return;
      case "set-tab":
        state.activeTab = action.tab;
        if (state.selectedSlug) {
          await loadBufferIfNeeded(state.selectedSlug, action.tab);
        }
        refs.refresh();
        return;
      case "set-buffer": {
        const key = bufferKey(action.slug, action.tab);
        state.editorBuffers.set(key, action.value);
        state.dirty.add(key);
        // No re-render — the textarea is DOM-controlled. We only update the
        // "save" indicator via the manual refresh below.
        refs.refreshToolbarOnly();
        return;
      }
      case "save":
        await saveBuffer();
        return;
      case "ai-edit":
        await aiEditBuffer(action.instruction);
        return;
      case "regenerate":
        await regeneratePhases();
        return;
      case "reset-prompt-to-global":
        await resetPromptToGlobal();
        return;
      case "add-phase":
        await addPhase();
        return;
      case "delete-phase":
        await deletePhase(action.slug);
        return;
      case "set-depends":
        setDepends(action.slug, action.deps);
        return;
      case "advance":
        advanceToStep3();
        return;
    }
  }

  async function loadBufferIfNeeded(slug: string, tab: FileTab): Promise<void> {
    const key = bufferKey(slug, tab);
    if (state.editorBuffers.has(key)) return;
    try {
      const content = await invoke<string>("loop_read_phase_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        phaseSlug: slug,
        file: tab,
      });
      state.editorBuffers.set(key, content);
    } catch {
      state.editorBuffers.set(key, "");
    }
  }

  async function saveBuffer(): Promise<void> {
    if (!state.selectedSlug) return;
    const tab = state.activeTab;
    const key = bufferKey(state.selectedSlug, tab);
    const content = state.editorBuffers.get(key) ?? "";
    state.busy = true;
    state.status = "saving…";
    refs.refresh();
    try {
      await invoke<void>("loop_write_phase_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        phaseSlug: state.selectedSlug,
        file: tab,
        content,
      });
      state.dirty.delete(key);
      state.status = "saved";
      await refreshDiskStatus();
    } catch (err) {
      state.status = `error saving: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  async function aiEditBuffer(instruction: string): Promise<void> {
    if (!state.selectedSlug) return;
    const tab = state.activeTab;
    const key = bufferKey(state.selectedSlug, tab);
    const fullContent = state.editorBuffers.get(key) ?? "";
    const textarea = refs.editorTextarea();
    let selection = "";
    let selStart = 0;
    let selEnd = 0;
    if (textarea) {
      selStart = textarea.selectionStart ?? 0;
      selEnd = textarea.selectionEnd ?? 0;
      selection = fullContent.slice(selStart, selEnd);
    }

    state.busy = true;
    state.status = "asking the AI…";
    refs.refresh();

    try {
      const prompt = buildAiEditPrompt(fullContent, selection, instruction, tab);
      const result = await invoke<AgentResult>("run_loop_agent", {
        cli: state.cli,
        model: defaultModelFor(state.cli),
        cwd: ctx.projectPath,
        systemPromptPath: null,
        userInput: prompt,
        timeoutSecs: 180,
      });
      if (result.error) {
        throw new Error(result.error);
      }
      const replacement = stripCodeFence(result.text.trim());
      if (!replacement) {
        throw new Error("empty response from agent");
      }
      let next: string;
      if (selection.length > 0 && selStart !== selEnd) {
        next = fullContent.slice(0, selStart) + replacement + fullContent.slice(selEnd);
      } else {
        // No selection: replace the entire buffer.
        next = replacement;
      }
      state.editorBuffers.set(key, next);
      state.dirty.add(key);
      state.status = "AI applied changes — review and save";
    } catch (err) {
      state.status = `AI error: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  async function regeneratePhases(): Promise<void> {
    state.busy = true;
    state.status = "reading 01-problem.md…";
    refs.refresh();

    let problem: string;
    try {
      problem = await invoke<string>("loop_read_run_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        file: "01-problem.md",
      });
    } catch (err) {
      state.busy = false;
      state.status = `could not read 01-problem.md: ${stringifyError(err)}`;
      refs.refresh();
      return;
    }
    if (!problem.trim()) {
      state.busy = false;
      state.status = "01-problem.md is empty — complete step 1 first";
      refs.refresh();
      return;
    }

    state.status = "generating phases…";
    refs.refresh();

    const systemPromptPath = buildRunPromptPath(
      ctx.projectPath,
      ctx.runId,
      "phase-decomposition.md",
    );

    try {
      const result = await invoke<AgentResult>("run_loop_agent", {
        cli: state.cli,
        model: defaultModelFor(state.cli),
        cwd: ctx.projectPath,
        systemPromptPath,
        userInput: problem,
        timeoutSecs: 180,
      });
      if (result.error) {
        throw new Error(result.error);
      }
      const drafts = parseAgentPhasesJson(result.text);
      if (drafts.length === 0) {
        throw new Error("the agent did not return parseable phases");
      }
      // The manifest only persists the Phase shape (without the logic/visual content).
      const phases: Phase[] = drafts.map((d) => ({
        id: d.id,
        name: d.name,
        summary: d.summary,
        dependsOn: d.dependsOn,
        hasVisual: d.hasVisual,
      }));
      // The LLM occasionally proposes a cyclic graph (especially when it
      // mixes "X depends on Y" with "Y references X"). Refuse early — we
      // don't want a manifest with a cycle on disk or its accompanying
      // phase directories, since downstream the scheduler bails anyway.
      const cycle = detectCycle(phases);
      if (cycle) {
        throw new Error(`the agent returned a cyclic dependency graph: ${cycle.join(" → ")}`);
      }
      await persistManifest(phases);
      for (const d of drafts) {
        const slug = phaseSlug(d);
        await invoke<string>("loop_create_phase_dir", {
          projectPath: ctx.projectPath,
          runId: ctx.runId,
          phaseSlug: slug,
          withVisual: d.hasVisual,
        });
        // Write the content returned by the agent. If it came back empty, we
        // leave the file blank (create_phase_dir already created it empty).
        if (d.logic && d.logic.trim()) {
          await invoke<void>("loop_write_phase_file", {
            projectPath: ctx.projectPath,
            runId: ctx.runId,
            phaseSlug: slug,
            file: "logic.md",
            content: d.logic,
          });
        }
        if (d.hasVisual && d.visual && d.visual.trim()) {
          await invoke<void>("loop_write_phase_file", {
            projectPath: ctx.projectPath,
            runId: ctx.runId,
            phaseSlug: slug,
            file: "visual.html",
            content: d.visual,
          });
        }
      }
      state.phases = phases;
      state.selectedSlug = phaseSlug(phases[0]);
      state.activeTab = "logic.md";
      // Clear buffers; we reload them on demand.
      state.editorBuffers.clear();
      state.dirty.clear();
      await refreshDiskStatus();
      state.status = `${phases.length} phases generated`;
    } catch (err) {
      state.status = `error generating: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  async function persistManifest(phases: Phase[]): Promise<void> {
    const content = serializePhasesManifest(phases);
    await invoke<void>("loop_write_run_file", {
      projectPath: ctx.projectPath,
      runId: ctx.runId,
      file: "02-phases.md",
      content,
    });
  }

  async function resetPromptToGlobal(): Promise<void> {
    state.busy = true;
    state.status = "resetting prompt…";
    refs.refresh();
    try {
      await invoke<void>("loop_reset_run_prompt_to_global", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        name: "phase-decomposition.md",
      });
      state.status = "run prompt updated to global";
    } catch (err) {
      state.status = `error resetting prompt: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  async function addPhase(): Promise<void> {
    const nextNum = state.phases.length + 1;
    const id = String(nextNum).padStart(2, "0");
    const name = `phase-${id}`;
    const newPhase: Phase = {
      id,
      name,
      summary: "",
      dependsOn: [],
      hasVisual: false,
    };
    state.phases = [...state.phases, newPhase];
    state.busy = true;
    refs.refresh();
    try {
      await invoke<string>("loop_create_phase_dir", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        phaseSlug: phaseSlug(newPhase),
        withVisual: false,
      });
      await persistManifest(state.phases);
      await refreshDiskStatus();
      state.selectedSlug = phaseSlug(newPhase);
      state.activeTab = "logic.md";
      state.status = `phase ${name} added`;
    } catch (err) {
      state.status = `error adding phase: ${stringifyError(err)}`;
      // Roll back the phase from state if we could not persist
      state.phases = state.phases.slice(0, -1);
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  async function deletePhase(slug: string): Promise<void> {
    // Look for dependents — if any, ask for confirmation.
    const dependents = state.phases.filter((p) => p.dependsOn.includes(slugToId(slug)));
    let warning = `Delete phase ${slug}?`;
    if (dependents.length > 0) {
      const names = dependents.map((d) => phaseSlug(d)).join(", ");
      warning += `\n\nWARNING: these phases depend on it: ${names}.\nThe dependency will be broken until you edit it manually.`;
    }
    if (!window.confirm(warning)) return;

    state.busy = true;
    refs.refresh();
    try {
      await invoke<void>("loop_delete_phase_dir", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        phaseSlug: slug,
      });
      state.phases = state.phases.filter((p) => phaseSlug(p) !== slug);
      // Delete buffers for that phase and clear selection if it was that one.
      for (const key of [...state.editorBuffers.keys()]) {
        if (key.startsWith(`${slug}:`)) {
          state.editorBuffers.delete(key);
          state.dirty.delete(key);
        }
      }
      if (state.selectedSlug === slug) {
        state.selectedSlug = state.phases.length > 0 ? phaseSlug(state.phases[0]) : null;
        state.activeTab = "logic.md";
      }
      await persistManifest(state.phases);
      await refreshDiskStatus();
      state.status = `phase ${slug} deleted`;
    } catch (err) {
      state.status = `error deleting: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  function setDepends(slug: string, deps: string[]): void {
    const phase = state.phases.find((p) => phaseSlug(p) === slug);
    if (!phase) return;
    // Validate cycles: if after applying the dep there is a cycle, show an
    // error and do not persist. Validation runs against a copy.
    const proposed = state.phases.map((p) =>
      phaseSlug(p) === slug ? { ...p, dependsOn: deps } : p,
    );
    const cycle = detectCycle(proposed);
    if (cycle) {
      state.cycleError = `cycle detected in dependencies: ${cycle.join(" → ")}`;
      refs.refresh();
      return;
    }
    state.cycleError = null;
    state.phases = proposed;
    // Persist manifest in the background — we do not block the UI.
    void invoke<void>("loop_write_run_file", {
      projectPath: ctx.projectPath,
      runId: ctx.runId,
      file: "02-phases.md",
      content: serializePhasesManifest(state.phases),
    }).catch((err) => {
      console.error("loop step2: could not persist manifest", err);
    });
    refs.refresh();
  }

  function advanceToStep3(): void {
    // Validate: every phase has logic.md with content.
    const missing = state.phases.filter((p) => {
      const s = state.diskStatus.get(phaseSlug(p));
      return !s || !s.hasLogic;
    });
    if (state.phases.length === 0) {
      state.status = "you need at least one phase";
      refs.refresh();
      return;
    }
    if (missing.length > 0) {
      const names = missing.map((p) => phaseSlug(p)).join(", ");
      state.status = `phases missing logic.md: ${names}`;
      refs.refresh();
      return;
    }
    // The hybrid-mode scheduler computes batches via topological sort and
    // refuses to run a cyclic graph; the sequential view ignores deps but
    // we still gate here so users can't ship a broken graph either way.
    const cycle = detectCycle(state.phases);
    if (cycle) {
      state.status = `cycle detected in dependencies: ${cycle.join(" → ")}`;
      refs.refresh();
      return;
    }
    ctx.onAdvance();
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

type Step2Action =
  | { kind: "set-cli"; cli: LoopCli }
  | { kind: "select-phase"; slug: string }
  | { kind: "set-tab"; tab: FileTab }
  | { kind: "set-buffer"; slug: string; tab: FileTab; value: string }
  | { kind: "save" }
  | { kind: "ai-edit"; instruction: string }
  | { kind: "regenerate" }
  | { kind: "reset-prompt-to-global" }
  | { kind: "add-phase" }
  | { kind: "delete-phase"; slug: string }
  | { kind: "set-depends"; slug: string; deps: string[] }
  | { kind: "advance" };

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

interface ViewRefs {
  refresh(): void;
  refreshToolbarOnly(): void;
  cleanup(): void;
  editorTextarea(): HTMLTextAreaElement | null;
}

function render(
  slot: HTMLElement,
  state: Step2State,
  ctx: Step2Context,
  dispatch: (action: Step2Action) => void,
): ViewRefs {
  slot.classList.add("loop-step2");

  const root = document.createElement("div");
  root.className = "loop-step2-root";
  slot.replaceChildren(root);

  const listeners = createListenerBag();
  const { on } = listeners;

  let editorTextareaRef: HTMLTextAreaElement | null = null;

  function refresh(): void {
    root.replaceChildren();
    editorTextareaRef = null;
    root.append(renderHeader(), renderBody(), renderFooter());
  }

  function refreshToolbarOnly(): void {
    // Only refresh the toolbar (save button) without losing the textarea
    // caret. Find the toolbar and replace it.
    const old = root.querySelector(".loop-step2-toolbar");
    if (old && old.parentElement) {
      const updated = renderEditorToolbar();
      old.replaceWith(updated);
    }
  }

  function cleanup(): void {
    listeners.dispose();
    slot.classList.remove("loop-step2");
  }

  // -------------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------------

  function renderHeader(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step2-header";

    const title = document.createElement("div");
    title.className = "loop-step2-title";
    title.textContent = "Step 2 · phase decomposition";

    const right = document.createElement("div");
    right.className = "loop-step2-header-right";

    const cliWrap = document.createElement("label");
    cliWrap.className = "loop-step2-cli-wrap";
    const cliLbl = document.createElement("span");
    cliLbl.className = "loop-step2-cli-label";
    cliLbl.textContent = "CLI";
    const cliSel = document.createElement("select");
    cliSel.className = "loop-step2-cli-select";
    cliSel.disabled = state.busy;
    for (const opt of LOOP_CLIS) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      if (opt === state.cli) o.selected = true;
      cliSel.appendChild(o);
    }
    on(cliSel, "change", () => {
      dispatch({ kind: "set-cli", cli: cliSel.value as LoopCli });
    });
    cliWrap.append(cliLbl, cliSel);

    const regen = document.createElement("button");
    regen.type = "button";
    regen.className = "loop-btn loop-btn-ghost";
    regen.textContent =
      state.busy && (state.status ?? "").startsWith("generating")
        ? "generating…"
        : "↻ regenerate from 01-problem.md";
    regen.disabled = state.busy;
    regen.title = "Invoke the agent with phase-decomposition.md on the consolidated problem";
    on(regen, "click", () => {
      const ok =
        state.phases.length === 0 ||
        window.confirm(
          "Regenerate the phases? Current manifests will be lost (files on disk remain, but the listing is replaced).",
        );
      if (ok) dispatch({ kind: "regenerate" });
    });

    const resetPrompt = document.createElement("button");
    resetPrompt.type = "button";
    resetPrompt.className = "loop-btn loop-btn-ghost";
    resetPrompt.textContent = "↑ reset prompt to global";
    resetPrompt.disabled = state.busy;
    resetPrompt.title =
      "Overwrites the run copy with the current contents of the global phase-decomposition.md (useful when the global was updated after the run was created)";
    on(resetPrompt, "click", () => {
      const ok = window.confirm(
        "Overwrite the run's phase-decomposition.md with the current global version? If you edited the run's prompt by hand, it will be lost.",
      );
      if (ok) dispatch({ kind: "reset-prompt-to-global" });
    });

    right.append(cliWrap, regen, resetPrompt);
    wrap.append(title, right);
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Body (sidebar + main + topology)
  // -------------------------------------------------------------------------

  function renderBody(): HTMLElement {
    const body = document.createElement("div");
    body.className = "loop-step2-body";
    body.append(renderSidebar(), renderMain());
    return body;
  }

  function renderSidebar(): HTMLElement {
    const aside = document.createElement("aside");
    aside.className = "loop-step2-sidebar";

    const head = document.createElement("div");
    head.className = "loop-step2-sidebar-head";
    const lbl = document.createElement("span");
    lbl.className = "loop-step2-sidebar-title";
    lbl.textContent = `Phases (${state.phases.length})`;
    const add = document.createElement("button");
    add.type = "button";
    add.className = "loop-btn loop-btn-ghost loop-step2-add-phase";
    add.textContent = "+ add phase";
    add.disabled = state.busy;
    on(add, "click", () => dispatch({ kind: "add-phase" }));
    head.append(lbl, add);
    aside.appendChild(head);

    if (state.phases.length === 0) {
      const empty = document.createElement("p");
      empty.className = "loop-step2-sidebar-empty";
      empty.textContent = 'No phases. Click "↻ regenerate" or "+ add phase" to begin.';
      aside.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "loop-step2-phase-list";
      for (const phase of state.phases) {
        list.appendChild(renderPhaseItem(phase));
      }
      aside.appendChild(list);
    }

    aside.appendChild(renderTopologyPanel());
    return aside;
  }

  function renderPhaseItem(phase: Phase): HTMLLIElement {
    const slug = phaseSlug(phase);
    const item = document.createElement("li");
    item.className = "loop-step2-phase-item";
    if (slug === state.selectedSlug) item.classList.add("loop-step2-phase-item-active");

    const main = document.createElement("button");
    main.type = "button";
    main.className = "loop-step2-phase-main";
    main.disabled = state.busy;
    on(main, "click", () => dispatch({ kind: "select-phase", slug }));

    const top = document.createElement("div");
    top.className = "loop-step2-phase-top";
    const num = document.createElement("span");
    num.className = "loop-step2-phase-num";
    num.textContent = phase.id;
    const name = document.createElement("span");
    name.className = "loop-step2-phase-name";
    name.textContent = phase.name;
    const badges = document.createElement("span");
    badges.className = "loop-step2-phase-badges";
    const status = state.diskStatus.get(slug);
    if (status?.hasLogic) {
      const b = document.createElement("span");
      b.className = "loop-step2-badge loop-step2-badge-md";
      b.textContent = "md";
      b.title = "logic.md has content";
      badges.appendChild(b);
    }
    if (status?.hasVisual) {
      const b = document.createElement("span");
      b.className = "loop-step2-badge loop-step2-badge-html";
      b.textContent = "html";
      b.title = "visual.html has content";
      badges.appendChild(b);
    }
    top.append(num, name, badges);

    const deps = document.createElement("div");
    deps.className = "loop-step2-phase-deps";
    if (phase.dependsOn.length === 0) {
      deps.textContent = "no dependencies";
      deps.classList.add("loop-step2-phase-deps-empty");
    } else {
      deps.textContent = `depends on: ${phase.dependsOn.join(", ")}`;
    }

    main.append(top, deps);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "loop-step2-phase-delete";
    del.textContent = "✕";
    del.title = "delete phase";
    del.disabled = state.busy;
    on(del, "click", (e: Event) => {
      e.stopPropagation();
      dispatch({ kind: "delete-phase", slug });
    });

    item.append(main, del);
    return item;
  }

  function renderTopologyPanel(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "loop-step2-topology";

    const head = document.createElement("div");
    head.className = "loop-step2-topology-head";
    head.textContent = "Execution topology";
    panel.appendChild(head);

    if (state.phases.length === 0) {
      const p = document.createElement("p");
      p.className = "loop-step2-topology-empty";
      p.textContent = "No phases to sort.";
      panel.appendChild(p);
      return panel;
    }

    const batches = topologicalBatches(state.phases);
    if (!batches) {
      const p = document.createElement("p");
      p.className = "loop-step2-topology-error";
      p.textContent = "There is a cycle in the dependencies — cannot sort.";
      panel.appendChild(p);
      return panel;
    }

    const lanes = document.createElement("ol");
    lanes.className = "loop-step2-lanes";
    for (let i = 0; i < batches.length; i++) {
      const lane = document.createElement("li");
      lane.className = "loop-step2-lane";
      const lbl = document.createElement("div");
      lbl.className = "loop-step2-lane-label";
      lbl.textContent = `batch ${i + 1}`;
      const items = document.createElement("div");
      items.className = "loop-step2-lane-items";
      for (const phase of batches[i]) {
        const chip = document.createElement("span");
        chip.className = "loop-step2-lane-chip";
        chip.textContent = `${phase.id} · ${phase.name}`;
        items.appendChild(chip);
      }
      lane.append(lbl, items);
      lanes.appendChild(lane);
    }
    panel.appendChild(lanes);
    return panel;
  }

  // -------------------------------------------------------------------------
  // Main panel (tabs + editor + toolbar + deps editor)
  // -------------------------------------------------------------------------

  function renderMain(): HTMLElement {
    const main = document.createElement("section");
    main.className = "loop-step2-main";

    const phase = state.phases.find((p) => phaseSlug(p) === state.selectedSlug);
    if (!phase) {
      const empty = document.createElement("p");
      empty.className = "loop-step2-main-empty";
      empty.textContent = "Pick a phase from the sidebar or add a new one.";
      main.appendChild(empty);
      return main;
    }

    main.append(
      renderTabs(phase),
      renderEditor(phase),
      renderEditorToolbar(),
      renderDepsEditor(phase),
    );
    return main;
  }

  function renderTabs(phase: Phase): HTMLElement {
    const tabs = document.createElement("div");
    tabs.className = "loop-step2-tabs";
    const slug = phaseSlug(phase);
    const status = state.diskStatus.get(slug);
    const showVisualTab = phase.hasVisual || status?.hasVisual === true;

    for (const tab of ["logic.md", "visual.html"] as const) {
      if (tab === "visual.html" && !showVisualTab) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "loop-step2-tab";
      if (tab === state.activeTab) btn.classList.add("loop-step2-tab-active");
      btn.textContent = tab;
      const key = bufferKey(slug, tab);
      if (state.dirty.has(key)) {
        const dot = document.createElement("span");
        dot.className = "loop-step2-tab-dirty";
        dot.textContent = " •";
        btn.appendChild(dot);
      }
      on(btn, "click", () => dispatch({ kind: "set-tab", tab }));
      tabs.appendChild(btn);
    }

    if (!showVisualTab) {
      const note = document.createElement("button");
      note.type = "button";
      note.className = "loop-step2-tab loop-step2-tab-add-visual";
      note.textContent = "+ visual.html";
      note.title = "Mark the phase as visual and add visual.html";
      on(note, "click", () => {
        // Mark the phase as visual and create the file. Persist immediately.
        void (async (): Promise<void> => {
          const updated = state.phases.map((p) =>
            phaseSlug(p) === slug ? { ...p, hasVisual: true } : p,
          );
          state.phases = updated;
          try {
            await invoke<string>("loop_create_phase_dir", {
              projectPath: ctx.projectPath,
              runId: ctx.runId,
              phaseSlug: slug,
              withVisual: true,
            });
            await invoke<void>("loop_write_run_file", {
              projectPath: ctx.projectPath,
              runId: ctx.runId,
              file: "02-phases.md",
              content: serializePhasesManifest(state.phases),
            });
            state.activeTab = "visual.html";
          } catch (err) {
            state.status = `error adding visual: ${stringifyError(err)}`;
          }
          refresh();
        })();
      });
      tabs.appendChild(note);
    }

    return tabs;
  }

  function renderEditor(phase: Phase): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step2-editor-wrap";

    const slug = phaseSlug(phase);
    const key = bufferKey(slug, state.activeTab);
    const content = state.editorBuffers.get(key) ?? "";

    const ta = document.createElement("textarea");
    ta.className = "loop-step2-editor";
    ta.spellcheck = false;
    ta.value = content;
    ta.disabled = state.busy;
    ta.placeholder =
      state.activeTab === "logic.md"
        ? "Logic content of the phase (markdown). Cmd+S to save."
        : "HTML of the phase's visual output.";
    on(ta, "input", () => {
      dispatch({
        kind: "set-buffer",
        slug,
        tab: state.activeTab,
        value: ta.value,
      });
    });
    on(ta, "keydown", (e: KeyboardEvent) => {
      if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        dispatch({ kind: "save" });
      }
    });
    editorTextareaRef = ta;
    wrap.appendChild(ta);
    return wrap;
  }

  function renderEditorToolbar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "loop-step2-toolbar";

    const phase = state.phases.find((p) => phaseSlug(p) === state.selectedSlug);
    const slug = phase ? phaseSlug(phase) : null;
    const key = slug ? bufferKey(slug, state.activeTab) : "";
    const dirty = key ? state.dirty.has(key) : false;

    const save = document.createElement("button");
    save.type = "button";
    save.className = "loop-btn loop-btn-primary loop-step2-save";
    save.textContent = dirty ? "save •" : "save";
    save.disabled = state.busy || !dirty;
    on(save, "click", () => dispatch({ kind: "save" }));

    const aiInput = document.createElement("input");
    aiInput.type = "text";
    aiInput.className = "loop-step2-ai-input";
    aiInput.placeholder = "instruction for AI (about the selection, or all of it)…";
    aiInput.disabled = state.busy;

    const aiBtn = document.createElement("button");
    aiBtn.type = "button";
    aiBtn.className = "loop-btn loop-step2-ai-btn";
    aiBtn.textContent = "✨ edit with AI";
    aiBtn.disabled = state.busy;
    on(aiBtn, "click", () => {
      const instr = aiInput.value.trim();
      if (!instr) return;
      dispatch({ kind: "ai-edit", instruction: instr });
      aiInput.value = "";
    });
    on(aiInput, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        aiBtn.click();
      }
    });

    const statusEl = document.createElement("span");
    statusEl.className = "loop-step2-toolbar-status";
    if (state.status) {
      statusEl.textContent = state.status;
      if (state.status.startsWith("error")) {
        statusEl.classList.add("loop-step2-toolbar-status-error");
      }
    }

    bar.append(save, aiInput, aiBtn, statusEl);
    return bar;
  }

  function renderDepsEditor(phase: Phase): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step2-deps-editor";

    const lbl = document.createElement("div");
    lbl.className = "loop-step2-deps-label";
    lbl.textContent = "Depends on:";

    const list = document.createElement("div");
    list.className = "loop-step2-deps-list";

    const others = state.phases.filter((p) => p.id !== phase.id);
    if (others.length === 0) {
      const note = document.createElement("p");
      note.className = "loop-step2-deps-empty";
      note.textContent = "There are no other phases — this is the only one.";
      list.appendChild(note);
    } else {
      for (const other of others) {
        const item = document.createElement("label");
        item.className = "loop-step2-deps-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = other.id;
        cb.checked = phase.dependsOn.includes(other.id);
        cb.disabled = state.busy;
        on(cb, "change", () => {
          const checked = list.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked");
          const deps = [...checked].map((c) => c.value);
          dispatch({ kind: "set-depends", slug: phaseSlug(phase), deps });
        });
        const span = document.createElement("span");
        span.textContent = `${other.id} · ${other.name}`;
        item.append(cb, span);
        list.appendChild(item);
      }
    }

    wrap.append(lbl, list);

    if (state.cycleError) {
      const err = document.createElement("p");
      err.className = "loop-step2-deps-error";
      err.textContent = state.cycleError;
      wrap.appendChild(err);
    }
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Footer: advance to step 3
  // -------------------------------------------------------------------------

  function renderFooter(): HTMLElement {
    const f = document.createElement("div");
    f.className = "loop-step2-footer";

    const info = document.createElement("span");
    info.className = "loop-step2-footer-info";
    const total = state.phases.length;
    const ready = state.phases.filter((p) => {
      const s = state.diskStatus.get(phaseSlug(p));
      return s?.hasLogic === true;
    }).length;
    info.textContent =
      total === 0
        ? "no phases"
        : ready === total
          ? `${total}/${total} phases with logic.md`
          : `${ready}/${total} phases with logic.md`;

    const advance = document.createElement("button");
    advance.type = "button";
    advance.className = "loop-btn loop-btn-primary";
    advance.textContent = "→ Step 3";
    const canAdvance = total > 0 && ready === total && !state.busy;
    advance.disabled = !canAdvance;
    advance.title = canAdvance ? "Advance to the run setup" : "All phases must have logic.md saved";
    on(advance, "click", () => dispatch({ kind: "advance" }));

    f.append(info, advance);
    return f;
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  refresh();
  void ctx;

  return {
    refresh,
    refreshToolbarOnly,
    cleanup,
    editorTextarea: () => editorTextareaRef,
  };
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function bufferKey(slug: string, tab: FileTab): string {
  return `${slug}:${tab}`;
}

/**
 * One-shot prompt for "edit with AI". If there is a selection, ask it to
 * return a replacement for that selection. Otherwise, ask for the full
 * document rewritten.
 */
function buildAiEditPrompt(
  full: string,
  selection: string,
  instruction: string,
  tab: FileTab,
): string {
  const kind = tab === "logic.md" ? "Markdown" : "HTML";
  if (selection.trim()) {
    return [
      `# Task`,
      `You have the file \`${tab}\` (${kind}) open. The user selected a fragment and requested a change.`,
      ``,
      `# Full document`,
      "```",
      full,
      "```",
      ``,
      `# Selected fragment (what you will replace)`,
      "```",
      selection,
      "```",
      ``,
      `# User instruction`,
      instruction,
      ``,
      `# Response`,
      `Return ONLY the new content that replaces the selected fragment. No code fences, no preamble. Preserve the style (${kind}, technical English, no emojis).`,
    ].join("\n");
  }
  return [
    `# Task`,
    `Rewrite the file \`${tab}\` (${kind}) following the user's instruction.`,
    ``,
    `# Current document`,
    "```",
    full,
    "```",
    ``,
    `# User instruction`,
    instruction,
    ``,
    `# Response`,
    `Return ONLY the complete content of the rewritten file. No code fences, no preamble.`,
  ].join("\n");
}
