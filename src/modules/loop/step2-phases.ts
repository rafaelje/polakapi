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
// Follows the "imperative view with re-render via replaceChildren()"
// pattern from step1-chat. Exposes `mountStep2Phases(slot, ctx)` with
// `dispose()`. The renderer lives in `./step2-phases/view.ts`; this file
// owns the state machine and the side effects (persistence, agent
// invocation, FS operations).

import { invoke } from "@tauri-apps/api/core";

import { stringifyError } from "../../shared/errors";

import { buildRunPromptPath, defaultModelFor } from "./state/types";
import { detectCycle, phaseSlug, slugToId, topologicalBatches } from "./step2-phases/graph";
import {
  parseAgentPhasesJson,
  parsePhasesManifest,
  serializePhasesManifest,
  stripCodeFence,
  type PhaseDraft,
} from "./step2-phases/manifest";
import type {
  FileTab,
  Phase,
  PhaseDirStatus,
  Step2Action,
  Step2Context,
  Step2State,
  ViewRefs,
} from "./step2-phases/state";
import { bufferKey, buildAiEditPrompt, renderView } from "./step2-phases/view";

// Re-export the helpers, PhaseDraft, and the public types so existing
// consumers (loop-chrome, step3-setup, run-scheduler) keep importing from
// `./step2-phases`.
export {
  detectCycle,
  parseAgentPhasesJson,
  parsePhasesManifest,
  phaseSlug,
  serializePhasesManifest,
  topologicalBatches,
};
export type { Phase, PhaseDraft, Step2Context };

export interface Step2Handle {
  dispose(): void;
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

  const refs: ViewRefs = renderView(slot, state, ctx, (action) => {
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
        // No re-render — the textarea is DOM-controlled. We only update
        // the "save" indicator via the manual refresh below.
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
      // The manifest only persists the Phase shape (without the
      // logic/visual content).
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
        // Write the content returned by the agent. If it came back empty,
        // we leave the file blank (create_phase_dir already created it
        // empty).
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
      // Delete buffers for that phase and clear selection if it was that
      // one.
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
