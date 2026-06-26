import { invoke } from "@tauri-apps/api/core";

import { stringifyError } from "../../../shared/errors";

import { buildRunPromptPath, defaultModelFor } from "../types";
import { detectCycle, phaseSlug, slugToId, topologicalBatches } from "./graph";
import {
  parseAgentPhasesJson,
  parsePhasesManifest,
  serializePhasesManifest,
  stripCodeFence,
  type PhaseDraft,
} from "./manifest";
import type {
  FileTab,
  Phase,
  PhaseDirStatus,
  Step2Action,
  Step2Context,
  Step2State,
  ViewRefs,
} from "./state";
import { bufferKey, buildAiEditPrompt, renderView } from "./view";

export {
  detectCycle,
  parseAgentPhasesJson,
  parsePhasesManifest,
  phaseSlug,
  serializePhasesManifest,
  topologicalBatches,
};
export type { Phase, PhaseDraft, Step2Context };

/**
 * Reinforces the "fewest phases possible" rule on every regenerate call. The
 * system prompt may be stale (existing global was seeded before the rule was
 * tightened) so we restate the policy alongside the user input.
 */
const SIMPLICITY_GUARDRAIL =
  "\n\n---\n[hard constraint — phase count: minimize phases, max 5, default 1. For small or focused problems return exactly ONE phase. Do NOT split work into many small phases to look thorough; merge anything that doesn't have a genuinely independent acceptance criterion. A 9-phase plan for a small change is wrong — prefer 1 or 2 phases.]";

export interface Step2Handle {
  dispose(): void;
}

interface AgentResult {
  text: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  sessionId?: string | null;
  error?: string | null;
}

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

  let disposed = false;

  const refs: ViewRefs = renderView(slot, state, ctx, (action) => {
    void handleAction(action);
  });

  void hydrate();

  async function hydrate(): Promise<void> {
    try {
      const manifest = await invoke<string>("loop_read_run_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        file: "02-phases.md",
      });
      if (disposed) return;
      if (manifest.trim()) {
        const phases = parsePhasesManifest(manifest);
        if (phases.length > 0) {
          state.phases = phases;
          state.selectedSlug = phaseSlug(phases[0]);
        }
      }
    } catch {
      // No manifest yet.
    }
    if (disposed) return;
    await refreshDiskStatus();
    if (disposed) return;
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
        // Textarea is DOM-controlled; avoid full re-render to keep caret.
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

    // Lazy seed: the run dir was created in step 1 without prompt files,
    // so we materialize phase-decomposition.md before the agent reads it.
    try {
      await invoke<void>("loop_ensure_run_prompt", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        name: "phase-decomposition.md",
      });
    } catch (err) {
      state.busy = false;
      state.status = `could not seed phase-decomposition.md: ${stringifyError(err)}`;
      refs.refresh();
      return;
    }

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
        userInput: problem + SIMPLICITY_GUARDRAIL,
        timeoutSecs: 180,
      });
      if (result.error) {
        throw new Error(result.error);
      }
      const drafts = parseAgentPhasesJson(result.text);
      if (drafts.length === 0) {
        throw new Error("the agent did not return parseable phases");
      }
      const phases: Phase[] = drafts.map((d) => ({
        id: d.id,
        name: d.name,
        summary: d.summary,
        dependsOn: d.dependsOn,
        hasVisual: d.hasVisual,
      }));
      // Refuse cyclic graphs early — scheduler bails on them downstream.
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
      state.phases = state.phases.slice(0, -1);
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  async function deletePhase(slug: string): Promise<void> {
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
      disposed = true;
      refs.cleanup();
    },
  };
}
