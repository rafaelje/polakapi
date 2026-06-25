// Paso 3 del flow agéntico: setup unificado del run.
//
// El paso 3 reúne en una sola vista todas las decisiones previas al ejecutar
// el run: modo (secuencial/híbrido), perfil cargado, los 7 prompts editables
// con CLI/modelo por agente, validación de slots, y la fila de config
// (retries, budget, on-fail). Apunta a que el usuario tenga visible toda la
// configuración antes de pulsar "▶ ejecutar run" (que esta Section 6 deja
// armado pero no lo conecta al engine — Section 7+ lo arma).
//
// Diseño general (alineado con design.md, decisión #10 "UI inline en el setup
// del Paso 3, no settings separado"):
// - Sidebar de los 7 prompts: 2 pre-fases (problem-intake / phase-decomposition)
//   informativos + 5 agentes (analysis / implementation / review / knowledge /
//   integration) con dropdowns de CLI/modelo y validación.
// - Panel principal: textarea del prompt seleccionado, botones "↑ resetear a
//   global" / "↓ guardar como default global", dropdowns CLI/modelo (sólo para
//   los 5 agentes), descripción de inputs/outputs.
// - Detección viva de `default` vs `modificado` comparando el textarea contra
//   el contenido del global.
// - Validación al cargar perfil: invoca `loop_validate_cli_model` por slot;
//   slots inválidos quedan en rojo y deshabilitan "▶ ejecutar run".
//
// Sigue el patrón "vista imperativa con re-render por replaceChildren()" del
// step1-chat / step2-phases. No introducimos framework. Expone
// `mountStep3Setup(slot, ctx)` con `dispose()`.

import { invoke } from "@tauri-apps/api/core";

import {
  flushSaveLoopProfiles,
  loadLoopProfiles,
  queueSaveLoopProfiles,
} from "../../shared/persistence/loop-profiles-store";
import { promptModal } from "../../shared/ui/modal";

import { topologicalBatches, parsePhasesManifest, type Phase } from "./step2-phases";
import { DEFAULT_AGENT_SLOT, LOOP_PROMPT_NAMES, createDefaultMatrix } from "./state/types";
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
// Tipos
// ---------------------------------------------------------------------------

export interface Step3Context {
  /** Path absoluto del project activo. */
  projectPath: string;
  /** Nombre legible del project (mostrado en la top bar). */
  projectName: string;
  /** CLI sugerido del project (chip activo del workspace). */
  suggestedCli: string | null;
  /** UUID del run actual. */
  runId: string;
  /**
   * Callback cuando el usuario pulsa "▶ ejecutar run". Section 6 deja el botón
   * armado y la validación funcionando; el wiring al scheduler vive en Section
   * 7 (engine secuencial) — por ahora el callback es opcional, si no se pasa
   * el botón muestra un mensaje "engine pendiente (Section 7+)".
   */
  onExecuteRun?: (config: RunConfig) => void;
}

export interface Step3Handle {
  dispose(): void;
}

/** Modo de ejecución del run. */
export type RunMode = "sequential" | "hybrid";

/**
 * Comportamiento al fallo. Read-only en esta iteración — design.md decisión #4
 * fija "cap del revisor en 3 con propagación de warning". Lo dejamos como
 * union para que Section 7 lo extienda sin tocar el shape.
 */
export type OnFailBehavior = "propagate-warning";

/**
 * Snapshot final que el botón "▶ ejecutar run" pasa al engine. Section 7
 * consume esto.
 */
export interface RunConfig {
  mode: RunMode;
  matrix: ProfileMatrix;
  /**
   * Override por prompt: para cada uno de los 7 prompts, contenido editado del
   * run (vs. el copiado del global). Sólo los modificados aparecen acá —
   * Section 7 usa el global por defecto.
   */
  promptOverrides: Partial<Record<LoopPromptName, string>>;
  config: {
    maxRetries: number;
    onFail: OnFailBehavior;
  };
}

type SlotValidation = CliValidation | { ok: null; reason: "pending" };

/** Estado interno del setup. */
interface Step3State {
  /** Perfiles cargados desde `profiles.json`. */
  profiles: LoopProfile[];
  /** Id del perfil cargado en la UI (null = "sin perfil — todo claude/opus-4-7"). */
  loadedProfileId: LoopProfileId | null;
  /** Matriz actual editable (independiente de `loadedProfileId` — se hidrata desde él al cargar). */
  matrix: ProfileMatrix;
  /** Modo de ejecución elegido por el usuario. */
  mode: RunMode;
  /** Prompt seleccionado en el sidebar. */
  selectedPrompt: LoopPromptName;
  /**
   * Buffers editables del textarea de prompt, indexados por nombre. Si la entrada
   * existe, ese es el contenido en pantalla; si no, leemos del archivo del run y
   * lo memoizamos acá.
   */
  promptBuffers: Map<LoopPromptName, string>;
  /** Contenido de los globales en memoria, para comparar default vs modificado. */
  globals: Map<LoopPromptName, string>;
  /** Validaciones por slot (sólo aplica a los 5 agentes). */
  validations: Map<LoopAgentRole, SlotValidation>;
  /** Config row. `maxRetries` y `onFail` son read-only por design. */
  config: {
    maxRetries: number;
    onFail: OnFailBehavior;
  };
  /** Mensaje status mostrado en la top bar (ej. "perfil guardado", error). */
  status: string | null;
  /** Si se está validando, guardando o ejecutando, deshabilita controles. */
  busy: boolean;
  /** Fases del run, leídas del 02-phases.md, para detectar "todo lineal". */
  phases: Phase[];
}

// ---------------------------------------------------------------------------
// Defaults y catálogos
// ---------------------------------------------------------------------------

const ALL_AGENT_ROLES: readonly LoopAgentRole[] = [
  "analysis",
  "implementation",
  "review",
  "knowledge",
  "integration",
] as const;

/**
 * Mapeo prompt-name → rol del agente. Los 2 prompts pre-fase no tienen rol del
 * agente — devuelve null para esos.
 */
function promptToRole(name: LoopPromptName): LoopAgentRole | null {
  switch (name) {
    case "problem-intake.md":
    case "phase-decomposition.md":
      return null;
    case "analysis.md":
      return "analysis";
    case "implementation.md":
      return "implementation";
    case "review.md":
      return "review";
    case "knowledge.md":
      return "knowledge";
    case "integration.md":
      return "integration";
  }
}

/** Descripción legible (input → output) por prompt. */
function promptBlurb(name: LoopPromptName): { title: string; io: string } {
  switch (name) {
    case "problem-intake.md":
      return {
        title: "Problem intake (pre-fase 1)",
        io: "input: chat con el usuario → output: 01-problem.md consolidado",
      };
    case "phase-decomposition.md":
      return {
        title: "Phase decomposition (pre-fase 2)",
        io: "input: 01-problem.md → output: lista JSON de fases con dependsOn",
      };
    case "analysis.md":
      return {
        title: "Análisis (agente 1)",
        io: "input: logic.md de la fase + knowledge previo → output: analysis.md",
      };
    case "implementation.md":
      return {
        title: "Implementación (agente 2)",
        io: "input: analysis.md → output: cambios en el repo + impl.md (diff snapshot)",
      };
    case "review.md":
      return {
        title: "Revisor (agente 3, cap 3 reintentos)",
        io: "input: analysis.md + impl.md + diff → output: review.md (approved | needs-changes)",
      };
    case "knowledge.md":
      return {
        title: "Conocimiento (agente 4)",
        io: "input: outputs de la fase → output: knowledge.md (≤ 2k tokens)",
      };
    case "integration.md":
      return {
        title: "Integrador (agente 5, sólo modo híbrido)",
        io: "input: knowledge.md de cada fase del batch + diffs → output: knowledge consolidado del batch",
      };
  }
}

/** Default por CLI cuando no hay perfil. Coincide con step1-chat / step2-phases. */
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

  // Hidratación inicial: perfiles, globales, fases del run.
  void hydrate();

  async function hydrate(): Promise<void> {
    state.busy = true;
    state.status = "cargando configuración…";
    refs.refresh();
    try {
      // Asegurar que el dir global de prompts exista (idempotente).
      await invoke<string[]>("loop_ensure_prompts_dir").catch(() => []);

      const profilesState = await loadLoopProfiles();
      state.profiles = profilesState.profiles;

      // Cargamos los 7 globales de una en paralelo — son archivos chicos.
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

      // Fases del run para la detección "hybrid ≡ sequential".
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
      state.status = `error cargando: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
      // Disparamos validación de los slots por default — pueden ser CLI/modelo
      // inválidos aunque el usuario no haya cargado un perfil.
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
        // Re-render para actualizar el badge default/modificado del sidebar.
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
    state.status = id ? "perfil cargado" : "sin perfil — defaults";
    refs.refresh();
    void validateAllSlots();
  }

  async function saveProfile(): Promise<void> {
    if (state.loadedProfileId === null) {
      state.status = "no hay perfil cargado — usá 'guardar como…'";
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
      state.status = "perfil guardado";
    } catch (err) {
      state.status = `error guardando perfil: ${stringifyError(err)}`;
    } finally {
      state.busy = false;
      refs.refresh();
    }
  }

  async function saveProfileAs(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      state.status = "el perfil necesita un nombre";
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
      state.status = `perfil "${trimmed}" guardado`;
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
    // Forzamos flush antes de que el toast diga "guardado" para que el usuario
    // no se sorprenda con un perfil que no aparece si cierra rápido. El debounce
    // del store ya cubre el caso de ráfagas; acá pedimos confirmación.
    await flushSaveLoopProfiles();
  }

  function loadPromptBufferIfNeeded(name: LoopPromptName): void {
    if (state.promptBuffers.has(name)) return;
    // Intentamos leer el override del run; si no existe, caemos al global.
    // El override del run para los prompts vive en `<run>/prompts/<name>` —
    // pero `loop_read_run_file` no expone los archivos de prompts (allowlist
    // restringida). En su lugar, leemos directamente con un read del global —
    // los buffers del run aún no se editan en step3 (Section 7 lo extiende si
    // hace falta). Mientras tanto, el buffer arranca igual al global.
    state.promptBuffers.set(name, state.globals.get(name) ?? "");
  }

  async function promoteToGlobal(name: LoopPromptName): Promise<void> {
    const content = state.promptBuffers.get(name) ?? "";
    state.busy = true;
    state.status = "guardando como default global…";
    refs.refresh();
    try {
      await invoke<void>("loop_write_global_prompt", { name, content });
      state.globals.set(name, content);
      state.status = `${name} promovido a default global`;
    } catch (err) {
      state.status = `error promoviendo: ${stringifyError(err)}`;
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
      state.status = "hay slots inválidos — corregilos antes de ejecutar";
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
      // Section 7+ va a pasar el callback. Mientras, dejamos feedback claro.
      state.status = "engine pendiente — Section 7 conecta el run scheduler";
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
// Acciones
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
// Vista
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

  const handlers: Array<{
    el: EventTarget;
    type: string;
    handler: EventListenerOrEventListenerObject;
  }> = [];

  function on<T extends Event>(el: EventTarget, type: string, handler: (e: T) => void): void {
    const wrapped = handler as EventListenerOrEventListenerObject;
    el.addEventListener(type, wrapped);
    handlers.push({ el, type, handler: wrapped });
  }

  function refresh(): void {
    root.replaceChildren();
    root.append(renderTopBar(), renderBody(), renderFooter());
  }

  function refreshValidationsOnly(): void {
    // Re-renderiza el sidebar (donde se muestran los badges de validación) y la
    // fila del footer (donde el botón ▶ depende de la validación). Evitamos
    // re-renderizar el textarea para no perder el caret.
    const sidebar = root.querySelector(".loop-step3-sidebar");
    if (sidebar) sidebar.replaceWith(renderSidebar());
    const footer = root.querySelector(".loop-step3-footer");
    if (footer) footer.replaceWith(renderFooter());
    // El panel principal del agente también muestra los dropdowns de CLI/modelo
    // con borde rojo cuando la validación falla.
    const mainSlot = root.querySelector(".loop-step3-main-validation");
    if (mainSlot) mainSlot.replaceWith(renderMainValidationRow(state.selectedPrompt));
  }

  function cleanup(): void {
    for (const { el, type, handler } of handlers) {
      el.removeEventListener(type, handler);
    }
    handlers.length = 0;
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
    cli.textContent = ctx.suggestedCli ? `CLI sugerido: ${ctx.suggestedCli}` : "sin CLI sugerido";
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
    lbl.textContent = "modo";

    const group = document.createElement("div");
    group.className = "loop-step3-mode-group";
    for (const mode of ["sequential", "hybrid"] as const) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "loop-step3-mode-btn";
      if (mode === state.mode) btn.classList.add("loop-step3-mode-btn-active");
      btn.textContent = mode === "sequential" ? "secuencial" : "híbrido";
      btn.disabled = state.busy;
      on(btn, "click", () => dispatch({ kind: "set-mode", mode }));
      group.appendChild(btn);
    }
    wrap.append(lbl, group);

    // Detección "modo paralelo equivalente a secuencial" — cuando todas las
    // fases están en lanes de 1, el híbrido degrada al secuencial. La aviso
    // como hint cuando el usuario eligió híbrido.
    if (state.mode === "hybrid" && state.phases.length > 0) {
      const batches = topologicalBatches(state.phases);
      if (batches && batches.every((b) => b.length === 1)) {
        const hint = document.createElement("span");
        hint.className = "loop-step3-mode-hint";
        hint.textContent = "(híbrido ≡ secuencial: DAG lineal)";
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
    lbl.textContent = "perfil";

    const sel = document.createElement("select");
    sel.className = "loop-step3-profile-select";
    sel.disabled = state.busy;
    sel.setAttribute("aria-label", "perfil de matriz CLI/modelo");
    const optNone = document.createElement("option");
    optNone.value = "";
    // Section 10.4 — empty state cuando no hay perfiles guardados. El hint
    // dentro del placeholder le dice al usuario que puede crear el primer
    // perfil con "guardar como…".
    optNone.textContent =
      state.profiles.length === 0
        ? "— sin perfiles guardados (usá 'guardar como…') —"
        : "— sin perfil (defaults) —";
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
    save.textContent = "guardar";
    save.disabled = state.busy || state.loadedProfileId === null;
    save.title =
      state.loadedProfileId === null
        ? "Cargá un perfil primero o usá 'guardar como…'"
        : "Pisa el perfil cargado con la matriz actual";
    on(save, "click", () => dispatch({ kind: "save-profile" }));

    const saveAs = document.createElement("button");
    saveAs.type = "button";
    saveAs.className = "loop-btn loop-btn-ghost";
    saveAs.textContent = "guardar como…";
    saveAs.disabled = state.busy;
    on(saveAs, "click", () => {
      // Section 10.2 — reemplaza window.prompt por el modal estilizado del
      // shared/ui. El modal usa Enter para confirmar y Esc para cancelar.
      void (async () => {
        const name = await promptModal({
          title: "Guardar perfil",
          message: "Nombre del perfil (se guarda en profiles.json, local a esta máquina).",
          placeholder: "ej. claude-only",
          confirmLabel: "guardar",
          cancelLabel: "cancelar",
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
    head.textContent = "Prompts del run";
    aside.appendChild(head);

    const list = document.createElement("ul");
    list.className = "loop-step3-prompt-list";

    // Grupo: pre-fases (2)
    const preHeading = document.createElement("li");
    preHeading.className = "loop-step3-prompt-section";
    preHeading.textContent = "Pre-fases";
    list.appendChild(preHeading);
    for (const name of LOOP_PROMPT_NAMES.slice(0, 2)) {
      list.appendChild(renderPromptItem(name));
    }

    // Grupo: agentes (5)
    const agentHeading = document.createElement("li");
    agentHeading.className = "loop-step3-prompt-section";
    agentHeading.textContent = "Agentes del Paso 3";
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
      badge.textContent = "modificado";
    } else {
      badge.classList.add("loop-step3-prompt-badge-default");
      badge.textContent = "default";
    }
    titleRow.appendChild(badge);

    btn.appendChild(titleRow);

    // Línea inferior: CLI/modelo (sólo para agentes) + tilde de validación.
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
        dot.title = "sin validar";
      } else if ("ok" in v && v.ok === null) {
        dot.classList.add("loop-step3-prompt-dot-pending");
        dot.title = "validando…";
      } else if (v.ok === true) {
        dot.classList.add("loop-step3-prompt-dot-ok");
        dot.title = "CLI y modelo válidos";
      } else {
        dot.classList.add("loop-step3-prompt-dot-error");
        dot.title = v.reason ?? "inválido";
      }
      meta.appendChild(dot);
      btn.appendChild(meta);
    } else {
      const meta = document.createElement("div");
      meta.className = "loop-step3-prompt-meta";
      const text = document.createElement("span");
      text.className = "loop-step3-prompt-cli loop-step3-prompt-cli-muted";
      text.textContent = "(usado en el paso 1/2)";
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
   * Dropdowns CLI/modelo + marca roja si la validación falló. Para los prompts
   * pre-fase (que no tienen rol del agente) se muestra una nota explicativa.
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
          ? "El CLI/modelo del intake se elige en el Paso 1. Acá sólo editás el prompt del agente."
          : "El CLI/modelo de la descomposición se elige en el Paso 2. Acá sólo editás el prompt del agente.";
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
    for (const c of ["claude", "codex", "opencode"] as const) {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      if (c === slot.cli) o.selected = true;
      cliSel.appendChild(o);
    }
    on(cliSel, "change", () => {
      const nextCli = cliSel.value as LoopCli;
      // Cuando se cambia el CLI, reseteamos el modelo al default del nuevo CLI
      // para no quedar con `opus-4-7` apuntando a codex (que no lo conoce).
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
    modelLbl.textContent = "modelo";
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
      err.textContent = v?.reason ?? "inválido";
      row.appendChild(err);
    } else if (v && "ok" in v && v.ok === null) {
      const pending = document.createElement("span");
      pending.className = "loop-step3-main-validation-pending";
      pending.textContent = "validando…";
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
    ta.placeholder = "Contenido del prompt (markdown). Cmd+S para promover a global.";
    ta.setAttribute("aria-label", `editor del prompt ${name} — Cmd+S guarda como default global`);
    on(ta, "input", () => {
      dispatch({ kind: "set-prompt-buffer", name, value: ta.value });
    });
    // Section 10.3 — Cmd+S promueve el buffer actual al global. Si no hay
    // cambios respecto al global, el dispatch es no-op (promote-to-global
    // detecta el caso). Mantenemos el evento sólo dentro del textarea para no
    // chocar con otros editores del módulo.
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
    reset.textContent = "↑ resetear a global";
    reset.disabled = state.busy || !isPromptModified(state, name);
    reset.title = "Descarta cambios en este run y vuelve al contenido del global";
    on(reset, "click", () => dispatch({ kind: "reset-to-global", name }));

    const promote = document.createElement("button");
    promote.type = "button";
    promote.className = "loop-btn loop-btn-ghost";
    promote.textContent = "↓ guardar como default global";
    promote.disabled = state.busy || !isPromptModified(state, name);
    promote.title = "Pisa el global con el contenido actual — afecta a runs futuros";
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
    retriesInput.title = "design.md decisión #4: cap fijo en 3 con warning propagado";
    retriesWrap.append(retriesLbl, retriesInput);

    // on-fail (read-only)
    const onFailWrap = document.createElement("label");
    onFailWrap.className = "loop-step3-config-field";
    const onFailLbl = document.createElement("span");
    onFailLbl.className = "loop-step3-config-label";
    onFailLbl.textContent = "al fallo";
    const onFailInput = document.createElement("input");
    onFailInput.type = "text";
    onFailInput.value = "propagar warning";
    onFailInput.readOnly = true;
    onFailInput.disabled = true;
    onFailInput.className = "loop-step3-config-input loop-step3-config-input-readonly";
    onFailInput.title = "design.md decisión #4: propagar warning al knowledge";
    onFailWrap.append(onFailLbl, onFailInput);

    config.append(retriesWrap, onFailWrap);

    const exec = document.createElement("button");
    exec.type = "button";
    exec.className = "loop-btn loop-btn-primary loop-step3-execute";
    const allowed = canExecute(state);
    exec.disabled = !allowed;
    const invalid = countInvalidSlots(state);
    if (invalid > 0) {
      exec.title = `${invalid} slot(s) inválido(s) — corregilos antes de ejecutar`;
    } else if (state.busy) {
      exec.title = "esperando que termine la validación";
    } else {
      exec.title = "Ejecuta el run con la configuración actual";
    }
    exec.textContent = "▶ ejecutar run";
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
// Helpers puros (también exportados para tests futuros y Section 7)
// ---------------------------------------------------------------------------

/** ¿El buffer del prompt difiere del global cargado en memoria? */
export function isPromptModified(state: Step3State, name: LoopPromptName): boolean {
  const buf = state.promptBuffers.get(name);
  if (buf === undefined) return false; // no fue cargado aún
  return buf !== (state.globals.get(name) ?? "");
}

/**
 * Si el modo es híbrido pero todas las fases caen en lanes de 1, el engine
 * degrada a secuencial. Esta función devuelve el modo "efectivo" que va a usar
 * el scheduler — Section 7+ debería respetarlo.
 */
export function effectiveMode(state: Step3State): RunMode {
  if (state.mode !== "hybrid") return state.mode;
  if (state.phases.length === 0) return "hybrid";
  const batches = topologicalBatches(state.phases);
  if (!batches) return state.mode;
  return batches.every((b) => b.length === 1) ? "sequential" : "hybrid";
}

/** Cantidad de slots con validación fallida (excluyendo "pending"). */
export function countInvalidSlots(state: Step3State): number {
  let n = 0;
  for (const role of ALL_AGENT_ROLES) {
    const v = state.validations.get(role);
    if (v && "ok" in v && v.ok === false) n += 1;
  }
  return n;
}

/** ¿Está bien armado para ejecutar? Validaciones cargadas y todas ok. */
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

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
