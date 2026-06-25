// Paso 2 del flow agéntico: descomposición en fases con editor inline.
//
// Diseño general (alineado con design.md, decisión #2 "modo paralelo con sort
// topológico"):
// - El paso 2 toma `<run>/01-problem.md` y, vía el agente con
//   `phase-decomposition.md` como system prompt, recibe un JSON con la lista
//   de fases. El JSON se valida y persiste como `02-phases.md` (un fence con
//   el JSON; usamos .md por consistencia con el resto del run, pero el contenido
//   parseable es el JSON dentro del fence o el documento entero si está limpio).
// - Cada fase tiene un subdir en `<run>/phases/<NN>-<slug>/` con `logic.md`
//   (siempre) y opcionalmente `visual.html` (cuando `hasVisual=true`).
// - El UI: sidebar de fases con badges y dependencias + panel principal con
//   tabs (logic.md / visual.html) + textarea editable + toolbar (guardar,
//   "✨ editar con AI"). Editor de dependsOn como multi-select. Vista de
//   topología read-only abajo del sidebar.
//
// Decisión de editor: textarea estilizado (NO Monaco). Razones:
// 1. Monaco no está en deps (`package.json:25-44`); agregarlo subiría el
//    bundle del /loop significativamente.
// 2. El editing acá es markdown ligero / HTML simple; un textarea con
//    monospace + line height generoso es suficiente para el scope del paso 2.
// 3. El editor con AI (selección + instrucción → diff aplicado) usa la
//    selection API estándar del DOM — funciona en textarea sin extras.
//
// Sigue el patrón "vista imperativa con re-render por replaceChildren()" del
// step1-chat. Expone `mountStep2Phases(slot, ctx)` con `dispose()`.

import { invoke } from "@tauri-apps/api/core";

import type { LoopCli } from "./state/types";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Una fase del paso 2 según el JSON del agente. */
export interface Phase {
  id: string;
  name: string;
  summary?: string;
  dependsOn: string[];
  hasVisual: boolean;
}

/** Resultado normalizado de `run_loop_agent` (mismo shape que step1-chat). */
interface AgentResult {
  text: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  sessionId?: string | null;
  error?: string | null;
}

/** Estado de disco de una fase devuelto por `loop_list_phase_dirs`. */
interface PhaseDirStatus {
  slug: string;
  hasLogic: boolean;
  hasVisual: boolean;
}

export interface Step2Context {
  /** Path absoluto del project activo. */
  projectPath: string;
  /** UUID del run actual. */
  runId: string;
  /** Callback cuando el usuario pulsa "→ Paso 3". Validado: todas las fases tienen logic.md. */
  onAdvance: () => void;
}

export interface Step2Handle {
  dispose(): void;
}

type FileTab = "logic.md" | "visual.html";

interface Step2State {
  /** Lista de fases ordenadas por id (1..N). */
  phases: Phase[];
  /** Slug de la fase seleccionada en el sidebar, o null si no hay ninguna. */
  selectedSlug: string | null;
  /** Tab activa del panel principal. */
  activeTab: FileTab;
  /** Estado de disco por slug — qué archivos hay materializados. */
  diskStatus: Map<string, PhaseDirStatus>;
  /** Contenido en buffer del editor (no guardado todavía) — keyed por `${slug}:${tab}`. */
  editorBuffers: Map<string, string>;
  /** Set de claves `${slug}:${tab}` con cambios sin guardar. */
  dirty: Set<string>;
  /** CLI elegido para invocar al agente del paso 2 / edición con AI. */
  cli: LoopCli;
  /** Mensaje status mostrado en el header (ej. "guardado", "generando…", error). */
  status: string | null;
  /** Si estamos generando fases o invocando AI, deshabilita controles. */
  busy: boolean;
  /** Error de validación del manifest (ciclos detectados, etc.). */
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

  // Bootstrap: leer manifest desde disco si existe; si no, sigue vacío hasta
  // que el usuario pulse "regenerar desde 01-problem.md".
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
      // No hay manifest aún — estado inicial vacío.
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
      // Si phases/ no existe, lo seguimos como vacío.
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
        // No re-render — el textarea es controlado por el DOM. Sólo
        // actualizamos el indicador "guardar" via refresh manual abajo.
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
    state.status = "guardando…";
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
      state.status = "guardado";
      await refreshDiskStatus();
    } catch (err) {
      state.status = `error al guardar: ${stringifyError(err)}`;
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
    state.status = "pidiéndole a la AI…";
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
        throw new Error("respuesta vacía del agente");
      }
      let next: string;
      if (selection.length > 0 && selStart !== selEnd) {
        next = fullContent.slice(0, selStart) + replacement + fullContent.slice(selEnd);
      } else {
        // Sin selección: reemplazamos el buffer completo.
        next = replacement;
      }
      state.editorBuffers.set(key, next);
      state.dirty.add(key);
      state.status = "AI aplicó cambios — revisá y guardá";
    } catch (err) {
      state.status = `error AI: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  async function regeneratePhases(): Promise<void> {
    state.busy = true;
    state.status = "leyendo 01-problem.md…";
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
      state.status = `no pude leer 01-problem.md: ${stringifyError(err)}`;
      refs.refresh();
      return;
    }
    if (!problem.trim()) {
      state.busy = false;
      state.status = "01-problem.md está vacío — completá el paso 1 primero";
      refs.refresh();
      return;
    }

    state.status = "generando fases…";
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
        throw new Error("el agente no devolvió fases parseables");
      }
      // El manifest sólo persiste el shape de Phase (sin el contenido logic/visual).
      const phases: Phase[] = drafts.map((d) => ({
        id: d.id,
        name: d.name,
        summary: d.summary,
        dependsOn: d.dependsOn,
        hasVisual: d.hasVisual,
      }));
      await persistManifest(phases);
      for (const d of drafts) {
        const slug = phaseSlug(d);
        await invoke<string>("loop_create_phase_dir", {
          projectPath: ctx.projectPath,
          runId: ctx.runId,
          phaseSlug: slug,
          withVisual: d.hasVisual,
        });
        // Escribir el contenido devuelto por el agente. Si vino vacío, dejamos
        // el archivo en blanco (el create_phase_dir ya lo creó vacío).
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
      // Limpio buffers; los re-cargamos a demanda.
      state.editorBuffers.clear();
      state.dirty.clear();
      await refreshDiskStatus();
      state.status = `${phases.length} fases generadas`;
    } catch (err) {
      state.status = `error generando: ${stringifyError(err)}`;
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
    state.status = "reseteando prompt…";
    refs.refresh();
    try {
      await invoke<void>("loop_reset_run_prompt_to_global", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        name: "phase-decomposition.md",
      });
      state.status = "prompt del run actualizado al global";
    } catch (err) {
      state.status = `error reseteando prompt: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  async function addPhase(): Promise<void> {
    const nextNum = state.phases.length + 1;
    const id = String(nextNum).padStart(2, "0");
    const name = `fase-${id}`;
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
      state.status = `fase ${name} agregada`;
    } catch (err) {
      state.status = `error agregando fase: ${stringifyError(err)}`;
      // Rollback de la fase del estado si no se pudo persistir
      state.phases = state.phases.slice(0, -1);
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  async function deletePhase(slug: string): Promise<void> {
    // Buscar dependientes — si los hay, pedir confirmación.
    const dependents = state.phases.filter((p) => p.dependsOn.includes(slugToId(slug)));
    let warning = `¿Borrar fase ${slug}?`;
    if (dependents.length > 0) {
      const names = dependents.map((d) => phaseSlug(d)).join(", ");
      warning += `\n\nATENCIÓN: estas fases dependen de ella: ${names}.\nLa dependencia quedará rota hasta que la edites manualmente.`;
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
      // Borrar buffers de esa fase y limpiar selección si era esa.
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
      state.status = `fase ${slug} borrada`;
    } catch (err) {
      state.status = `error borrando: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  function setDepends(slug: string, deps: string[]): void {
    const phase = state.phases.find((p) => phaseSlug(p) === slug);
    if (!phase) return;
    // Validar ciclos: si después de aplicar dep, hay ciclo, mostramos error
    // y no persistimos. La validación se hace contra una copia.
    const proposed = state.phases.map((p) =>
      phaseSlug(p) === slug ? { ...p, dependsOn: deps } : p,
    );
    const cycle = detectCycle(proposed);
    if (cycle) {
      state.cycleError = `ciclo detectado en dependencias: ${cycle.join(" → ")}`;
      refs.refresh();
      return;
    }
    state.cycleError = null;
    state.phases = proposed;
    // Persistir manifest en background — no bloqueamos el UI.
    void invoke<void>("loop_write_run_file", {
      projectPath: ctx.projectPath,
      runId: ctx.runId,
      file: "02-phases.md",
      content: serializePhasesManifest(state.phases),
    }).catch((err) => {
      console.error("loop step2: no pude persistir manifest", err);
    });
    refs.refresh();
  }

  function advanceToStep3(): void {
    // Validar: cada fase tiene logic.md con contenido.
    const missing = state.phases.filter((p) => {
      const s = state.diskStatus.get(phaseSlug(p));
      return !s || !s.hasLogic;
    });
    if (state.phases.length === 0) {
      state.status = "necesitás al menos una fase";
      refs.refresh();
      return;
    }
    if (missing.length > 0) {
      const names = missing.map((p) => phaseSlug(p)).join(", ");
      state.status = `fases sin logic.md: ${names}`;
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
// Acciones
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
// Vista
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

  const handlers: Array<{
    el: EventTarget;
    type: string;
    handler: EventListenerOrEventListenerObject;
  }> = [];

  let editorTextareaRef: HTMLTextAreaElement | null = null;

  function on<T extends Event>(el: EventTarget, type: string, handler: (e: T) => void): void {
    const wrapped = handler as EventListenerOrEventListenerObject;
    el.addEventListener(type, wrapped);
    handlers.push({ el, type, handler: wrapped });
  }

  function refresh(): void {
    root.replaceChildren();
    editorTextareaRef = null;
    root.append(renderHeader(), renderBody(), renderFooter());
  }

  function refreshToolbarOnly(): void {
    // Sólo refresca la toolbar (botón guardar) sin perder el caret del
    // textarea. Buscamos la toolbar y la reemplazamos.
    const old = root.querySelector(".loop-step2-toolbar");
    if (old && old.parentElement) {
      const updated = renderEditorToolbar();
      old.replaceWith(updated);
    }
  }

  function cleanup(): void {
    for (const { el, type, handler } of handlers) {
      el.removeEventListener(type, handler);
    }
    handlers.length = 0;
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
    title.textContent = "Paso 2 · descomposición en fases";

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
    for (const opt of ["claude", "codex", "opencode"] as const) {
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
      state.busy && (state.status ?? "").startsWith("generando")
        ? "generando…"
        : "↻ regenerar desde 01-problem.md";
    regen.disabled = state.busy;
    regen.title = "Invoca al agente con phase-decomposition.md sobre el problema consolidado";
    on(regen, "click", () => {
      const ok =
        state.phases.length === 0 ||
        window.confirm(
          "¿Regenerar las fases? Se pierden los manifests actuales (los archivos en disco quedan, pero el listado se reemplaza).",
        );
      if (ok) dispatch({ kind: "regenerate" });
    });

    const resetPrompt = document.createElement("button");
    resetPrompt.type = "button";
    resetPrompt.className = "loop-btn loop-btn-ghost";
    resetPrompt.textContent = "↑ resetear prompt a global";
    resetPrompt.disabled = state.busy;
    resetPrompt.title =
      "Pisa la copia del run con el contenido actual de phase-decomposition.md global (útil cuando el global se actualizó después de crear el run)";
    on(resetPrompt, "click", () => {
      const ok = window.confirm(
        "¿Pisar phase-decomposition.md del run con la versión global actual? Si editaste el prompt del run a mano, se pierde.",
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
    lbl.textContent = `Fases (${state.phases.length})`;
    const add = document.createElement("button");
    add.type = "button";
    add.className = "loop-btn loop-btn-ghost loop-step2-add-phase";
    add.textContent = "+ agregar fase";
    add.disabled = state.busy;
    on(add, "click", () => dispatch({ kind: "add-phase" }));
    head.append(lbl, add);
    aside.appendChild(head);

    if (state.phases.length === 0) {
      const empty = document.createElement("p");
      empty.className = "loop-step2-sidebar-empty";
      empty.textContent = 'Sin fases. Pulsá "↻ regenerar" o "+ agregar fase" para empezar.';
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
      b.title = "logic.md tiene contenido";
      badges.appendChild(b);
    }
    if (status?.hasVisual) {
      const b = document.createElement("span");
      b.className = "loop-step2-badge loop-step2-badge-html";
      b.textContent = "html";
      b.title = "visual.html tiene contenido";
      badges.appendChild(b);
    }
    top.append(num, name, badges);

    const deps = document.createElement("div");
    deps.className = "loop-step2-phase-deps";
    if (phase.dependsOn.length === 0) {
      deps.textContent = "sin dependencias";
      deps.classList.add("loop-step2-phase-deps-empty");
    } else {
      deps.textContent = `depende de: ${phase.dependsOn.join(", ")}`;
    }

    main.append(top, deps);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "loop-step2-phase-delete";
    del.textContent = "✕";
    del.title = "borrar fase";
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
    head.textContent = "Topología de ejecución";
    panel.appendChild(head);

    if (state.phases.length === 0) {
      const p = document.createElement("p");
      p.className = "loop-step2-topology-empty";
      p.textContent = "Sin fases para ordenar.";
      panel.appendChild(p);
      return panel;
    }

    const batches = topologicalBatches(state.phases);
    if (!batches) {
      const p = document.createElement("p");
      p.className = "loop-step2-topology-error";
      p.textContent = "Hay un ciclo en las dependencias — no se puede ordenar.";
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
      empty.textContent = "Elegí una fase del sidebar o agregá una nueva.";
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
      note.title = "Marca la fase como visual y agrega visual.html";
      on(note, "click", () => {
        // Marcar la fase como visual y crear el archivo. Lo persistimos al toque.
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
            state.status = `error agregando visual: ${stringifyError(err)}`;
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
        ? "Contenido lógico de la fase (markdown). Cmd+S para guardar."
        : "HTML del output visual de la fase.";
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
    save.textContent = dirty ? "guardar •" : "guardar";
    save.disabled = state.busy || !dirty;
    on(save, "click", () => dispatch({ kind: "save" }));

    const aiInput = document.createElement("input");
    aiInput.type = "text";
    aiInput.className = "loop-step2-ai-input";
    aiInput.placeholder = "instrucción para AI (sobre la selección, o todo)…";
    aiInput.disabled = state.busy;

    const aiBtn = document.createElement("button");
    aiBtn.type = "button";
    aiBtn.className = "loop-btn loop-step2-ai-btn";
    aiBtn.textContent = "✨ editar con AI";
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
    lbl.textContent = "Depende de:";

    const list = document.createElement("div");
    list.className = "loop-step2-deps-list";

    const others = state.phases.filter((p) => p.id !== phase.id);
    if (others.length === 0) {
      const note = document.createElement("p");
      note.className = "loop-step2-deps-empty";
      note.textContent = "No hay otras fases — esta es la única.";
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
        ? "sin fases"
        : ready === total
          ? `${total}/${total} fases con logic.md`
          : `${ready}/${total} fases con logic.md`;

    const advance = document.createElement("button");
    advance.type = "button";
    advance.className = "loop-btn loop-btn-primary";
    advance.textContent = "→ Paso 3";
    const canAdvance = total > 0 && ready === total && !state.busy;
    advance.disabled = !canAdvance;
    advance.title = canAdvance
      ? "Avanzar al setup del run"
      : "Necesitás que todas las fases tengan logic.md guardado";
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
// Helpers de fases (parsing, serialización, topología)
// ---------------------------------------------------------------------------

/**
 * Slug del directorio de una fase: `<id>-<name>`. Coincide con el saneador
 * del backend (`safe_run_id`): sólo [A-Za-z0-9_-]. El nombre kebab-case del
 * JSON del agente ya cumple; reforzamos por las dudas.
 */
export function phaseSlug(phase: Phase): string {
  const safeName = phase.name.replace(/[^A-Za-z0-9_-]/g, "-");
  return `${phase.id}-${safeName}`;
}

function slugToId(slug: string): string {
  const m = slug.match(/^(\d+)/);
  return m ? m[1] : slug;
}

/** Serializa el manifest como JSON pretty-printed dentro de un fence ```json. */
export function serializePhasesManifest(phases: Phase[]): string {
  const body = JSON.stringify({ phases }, null, 2);
  return `# Fases del run\n\n\`\`\`json\n${body}\n\`\`\`\n`;
}

/**
 * Parser inverso del manifest. Tolerante: extrae el primer fence ```json del
 * documento, o parsea el contenido entero si parece JSON puro.
 */
export function parsePhasesManifest(content: string): Phase[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const fenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/);
  const body = fenceMatch ? fenceMatch[1] : trimmed;
  try {
    const obj: unknown = JSON.parse(body);
    let list: unknown[] | null = null;
    if (Array.isArray(obj)) {
      list = obj;
    } else if (obj && typeof obj === "object") {
      const maybe = (obj as { phases?: unknown }).phases;
      if (Array.isArray(maybe)) list = maybe;
    }
    if (!list) return [];
    return list.map((entry) => normalizePhase(entry)).filter((p): p is Phase => p !== null);
  } catch {
    return [];
  }
}

/**
 * Draft de fase recién devuelta por el agente — extiende Phase con el contenido
 * inicial de logic.md y, opcionalmente, visual.html. Lo separamos del Phase
 * canónico porque el manifest (02-phases.md) NO persiste el contenido — ese
 * vive en logic.md / visual.html en disco.
 */
export interface PhaseDraft extends Phase {
  logic?: string;
  visual?: string;
}

/**
 * Parsea el output del agente del paso 2. El prompt pide JSON estricto, pero
 * algunos CLIs envuelven en fences o agregan preámbulos — tolerantes. Devuelve
 * `PhaseDraft[]` con los campos extra `logic`/`visual` que el agente arma.
 */
export function parseAgentPhasesJson(text: string): PhaseDraft[] {
  const cleaned = stripCodeFence(text.trim());
  try {
    const obj = JSON.parse(cleaned);
    let list: unknown[] | null = null;
    if (Array.isArray(obj)) {
      list = obj;
    } else if (obj && typeof obj === "object") {
      const maybe = (obj as { phases?: unknown }).phases;
      if (Array.isArray(maybe)) list = maybe;
    }
    if (!list) return [];
    return list.map((entry) => normalizePhaseDraft(entry)).filter((p): p is PhaseDraft => p !== null);
  } catch {
    return [];
  }
}

function normalizePhase(raw: unknown): Phase | null {
  const draft = normalizePhaseDraft(raw);
  if (!draft) return null;
  return {
    id: draft.id,
    name: draft.name,
    summary: draft.summary,
    dependsOn: draft.dependsOn,
    hasVisual: draft.hasVisual,
  };
}

function normalizePhaseDraft(raw: unknown): PhaseDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  const name = typeof r.name === "string" ? r.name : null;
  if (!id || !name) return null;
  const summary = typeof r.summary === "string" ? r.summary : "";
  const dependsOn = Array.isArray(r.dependsOn)
    ? r.dependsOn.filter((d): d is string => typeof d === "string")
    : [];
  const hasVisual = r.hasVisual === true;
  const logic = typeof r.logic === "string" ? r.logic : undefined;
  const visual = typeof r.visual === "string" ? r.visual : undefined;
  return { id, name, summary, dependsOn, hasVisual, logic, visual };
}

/**
 * Detecta un ciclo en el grafo de dependencias. Devuelve el camino del ciclo
 * (lista de ids) o null si no hay. DFS con tres colores estándar.
 */
export function detectCycle(phases: Phase[]): string[] | null {
  const byId = new Map(phases.map((p) => [p.id, p]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(phases.map((p) => [p.id, WHITE]));
  const parent = new Map<string, string | null>();
  let cycleStart: string | null = null;
  let cycleEnd: string | null = null;

  function dfs(u: string): boolean {
    color.set(u, GRAY);
    const phase = byId.get(u);
    if (!phase) {
      color.set(u, BLACK);
      return false;
    }
    for (const v of phase.dependsOn) {
      if (!byId.has(v)) continue; // referencia muerta — la ignoramos
      const c = color.get(v) ?? WHITE;
      if (c === WHITE) {
        parent.set(v, u);
        if (dfs(v)) return true;
      } else if (c === GRAY) {
        cycleStart = v;
        cycleEnd = u;
        return true;
      }
    }
    color.set(u, BLACK);
    return false;
  }

  for (const p of phases) {
    if ((color.get(p.id) ?? WHITE) === WHITE) {
      parent.set(p.id, null);
      if (dfs(p.id)) break;
    }
  }

  if (cycleStart === null || cycleEnd === null) return null;
  // Reconstrucción del camino: desde cycleEnd subiendo por parent hasta cycleStart.
  const path: string[] = [cycleStart];
  let cur: string | null = cycleEnd;
  while (cur && cur !== cycleStart) {
    path.push(cur);
    cur = parent.get(cur) ?? null;
  }
  path.push(cycleStart);
  return path.reverse();
}

/**
 * Sort topológico por niveles (Kahn). Devuelve `Phase[][]` (cada subarreglo
 * es un batch del modo híbrido). Devuelve null si hay ciclo.
 */
export function topologicalBatches(phases: Phase[]): Phase[][] | null {
  if (detectCycle(phases)) return null;
  const inDeg = new Map<string, number>();
  const byId = new Map(phases.map((p) => [p.id, p]));
  for (const p of phases) {
    // Sólo contamos deps que existen en el set (ignoramos referencias muertas).
    const real = p.dependsOn.filter((d) => byId.has(d));
    inDeg.set(p.id, real.length);
  }
  const remaining = new Set(phases.map((p) => p.id));
  const batches: Phase[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => (inDeg.get(id) ?? 0) === 0);
    if (ready.length === 0) return null; // ciclo escapado (defensa)
    const batch: Phase[] = [];
    for (const id of ready) {
      const p = byId.get(id);
      if (p) batch.push(p);
      remaining.delete(id);
    }
    // Restar 1 a las deps que apuntaban a los nodos consumidos.
    for (const id of remaining) {
      const p = byId.get(id);
      if (!p) continue;
      const stillBlocking = p.dependsOn.filter((d) => remaining.has(d) && byId.has(d)).length;
      inDeg.set(id, stillBlocking);
    }
    batches.push(batch);
  }
  return batches;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function bufferKey(slug: string, tab: FileTab): string {
  return `${slug}:${tab}`;
}

function buildRunPromptPath(projectPath: string, runId: string, name: string): string {
  // Mismo join que step1-chat.ts — la convención es nativa según el SO.
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return [projectPath, ".loop", "runs", runId, "prompts", name].join(sep);
}

function defaultModelFor(cli: LoopCli): string {
  switch (cli) {
    case "claude":
      return "claude-opus-4-7";
    case "codex":
      return "gpt-5";
    case "opencode":
      return "anthropic/claude-sonnet-4-5";
  }
}

/**
 * Prompt one-shot para "editar con AI". Si hay selección, le pedimos que
 * devuelva un reemplazo de esa selección. Si no, le pedimos el documento
 * completo reescrito.
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
      `# Tarea`,
      `Tenés el archivo \`${tab}\` (${kind}) abierto. El usuario seleccionó un fragmento y pidió un cambio.`,
      ``,
      `# Documento completo`,
      "```",
      full,
      "```",
      ``,
      `# Fragmento seleccionado (lo que vas a reemplazar)`,
      "```",
      selection,
      "```",
      ``,
      `# Instrucción del usuario`,
      instruction,
      ``,
      `# Respuesta`,
      `Devolvé SOLO el nuevo contenido que reemplaza al fragmento seleccionado. Sin code fences, sin preámbulo. Conservá el estilo (${kind}, castellano rioplatense, sin emojis).`,
    ].join("\n");
  }
  return [
    `# Tarea`,
    `Reescribí el archivo \`${tab}\` (${kind}) siguiendo la instrucción del usuario.`,
    ``,
    `# Documento actual`,
    "```",
    full,
    "```",
    ``,
    `# Instrucción del usuario`,
    instruction,
    ``,
    `# Respuesta`,
    `Devolvé SOLO el contenido completo del archivo reescrito. Sin code fences, sin preámbulo.`,
  ].join("\n");
}

/** Quita un fence ```...``` envolvente si lo tiene; útil para outputs LLM. */
function stripCodeFence(s: string): string {
  const m = s.match(/^```(?:[a-zA-Z]*)\n([\s\S]*?)\n```$/);
  return m ? m[1] : s;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
