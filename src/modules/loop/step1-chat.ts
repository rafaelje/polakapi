// Paso 1 del flow agéntico: chat de problem intake.
//
// Diseño general (alineado con design.md, decisión #3 "one-shot CLI"):
// - Cada turno es one-shot: serializamos toda la historia previa en el prompt
//   y la pasamos como `userInput` a `run_loop_agent`. No usamos sessions
//   persistentes del CLI; eso acoplaría formatos heterogéneos (claude JSON vs
//   codex JSONL vs opencode events) e impediría la mezcla de CLIs.
// - El sistema escribe el draft completo (`<run>/01-problem-draft.md`) tras
//   cada turno como auto-save (para resume en Section 9). Cuando el usuario
//   pulsa "consolidar", se invoca un último turno pidiendo el resumen
//   estructurado y se persiste en `<run>/01-problem.md`.
// - Mientras el `run_dir` no exista en disco (primer turno), se llama a
//   `loop_create_run` para inicializarlo con los prompts copiados.
//
// Sigue el patrón "vista imperativa con re-render por replaceChildren()" que
// ya usa `loop-chrome.ts`. No introducimos framework. El módulo expone
// `mountStep1Chat(slot, ctx)` que devuelve un handle con `dispose()` y
// `getTurnCount()` (útil para el chrome si quiere mostrar contadores en el
// futuro).

import { invoke } from "@tauri-apps/api/core";

import { LOOP_PROMPT_NAMES } from "./state/types";
import type { LoopCli, LoopPromptName } from "./state/types";

/** Resultado normalizado de `run_loop_agent`. Mirror del struct en Rust. */
interface AgentResult {
  text: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  sessionId?: string | null;
  error?: string | null;
}

/** Paths devueltos por `loop_create_run`. */
interface CreatedRunPaths {
  runDir: string;
  promptsDir: string;
}

/** Un turno de la conversación: el mensaje del usuario y la respuesta del agente. */
export interface ChatTurn {
  user: string;
  /** Vacío mientras la respuesta está en curso. */
  assistant: string;
  /** `true` mientras el subproceso del CLI corre — se usa para deshabilitar el input. */
  pending: boolean;
  /** Si la invocación falló, mensaje legible para mostrar in-line. */
  error?: string;
  /** Tokens reportados por el CLI, si los hubo. */
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export interface Step1Context {
  /** Path absoluto del project activo. Heredado del workspace via router. */
  projectPath: string;
  /** UUID del run actual. Heredado del router. */
  runId: string;
  /** Callback al consolidar — el chrome avanza al paso 2 al recibir esto. */
  onConsolidate: () => void;
  /**
   * Adoptar un run existente: el chrome cambia el runId al pasado y opcionalmente
   * salta a otro paso. El paso 1 lo invoca cuando el usuario elige un run del
   * picker de "runs anteriores".
   */
  onAdoptRun?: (runId: string, step?: 1 | 2 | 3) => void;
}

export interface Step1Handle {
  dispose(): void;
  /** Lectura del número de turnos completados (útil para tests/futuras vistas). */
  getTurnCount(): number;
}

/**
 * Monta el chat dentro del slot dado (typically `#loop-step-slot`). Re-monta
 * desde cero: el chrome borra y recrea el slot cuando cambia el step, así que
 * el handle vive sólo mientras el usuario esté en el paso 1.
 */
export function mountStep1Chat(slot: HTMLElement, ctx: Step1Context): Step1Handle {
  const state: Step1State = {
    turns: [],
    cli: "claude",
    inputDraft: "",
    consolidating: false,
    consolidatedExists: false,
    sessionByCli: {},
    pickerOpen: false,
    runsList: null,
    pickerLoading: false,
  };

  // El run_dir se crea perezosamente al primer turno — si el usuario sólo
  // abre el paso y cierra la ventana sin hablar, no ensuciamos el FS con un
  // dir vacío. Una vez creado, mantenemos el flag para evitar la doble
  // llamada (loop_create_run rechaza si el dir ya existe).
  let runDirReady = false;

  const refs: ViewRefs = render(slot, state, ctx, async (action) => {
    await handleAction(action);
  });

  // Hidratamos draft desde disco si existe (resume parcial — Section 9 hará
  // el resume formal con state.json; por ahora si encontramos draft, mostramos
  // un banner "se detectó un draft previo" no destructivo).
  void hydrateDraft();

  async function hydrateDraft(): Promise<void> {
    let touched = false;
    try {
      const draft = await invoke<string>("loop_read_run_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        file: "01-problem-draft.md",
      });
      if (draft.trim().length > 0) {
        const parsed = parseDraftMarkdown(draft);
        if (parsed.length > 0) {
          state.turns = parsed;
          runDirReady = true;
          touched = true;
        }
      }
    } catch {
      // Run dir aún no existe o lectura falló; sin draft, sin error visible.
    }
    // Detectamos si ya existe un `01-problem.md` consolidado. Cubre dos casos:
    //   (a) el usuario consolidó, navegó al paso 2 y volvió al paso 1.
    //   (b) el usuario abrió un run viejo (resume) que ya tenía consolidado.
    // En ambos casos mostramos el atajo "saltar al paso 2 con el problem.md
    // existente" para no obligar a rehacer el chat.
    try {
      const consolidated = await invoke<string>("loop_read_run_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        file: "01-problem.md",
      });
      if (consolidated.trim().length > 0) {
        state.consolidatedExists = true;
        runDirReady = true;
        touched = true;
      }
    } catch {
      // Mismo motivo que arriba: no hay archivo o run_dir no existe — no es error.
    }
    if (touched) refs.refresh();
  }

  async function handleAction(action: ChatAction): Promise<void> {
    switch (action.kind) {
      case "set-cli":
        state.cli = action.cli;
        refs.refresh();
        return;
      case "set-input":
        state.inputDraft = action.value;
        // No re-render: el input es controlado por el DOM en sí, no quiero
        // re-pintar mientras tipean. Sólo refrescamos en submit/send.
        return;
      case "send":
        await sendTurn();
        return;
      case "consolidate":
        await consolidate();
        return;
      case "skip-to-step-2":
        // Atajo: el run ya tiene `01-problem.md`. Saltamos directo al paso 2
        // sin volver a invocar al agente consolidador.
        ctx.onConsolidate();
        return;
      case "toggle-picker":
        state.pickerOpen = !state.pickerOpen;
        if (state.pickerOpen && state.runsList === null) {
          state.pickerLoading = true;
          refs.refresh();
          try {
            state.runsList = await invoke<RunSummary[]>("loop_list_runs", {
              projectPath: ctx.projectPath,
            });
          } catch (err) {
            console.error("loop step1: no pude listar runs", err);
            state.runsList = [];
          } finally {
            state.pickerLoading = false;
          }
        }
        refs.refresh();
        return;
      case "adopt-run":
        state.pickerOpen = false;
        refs.refresh();
        ctx.onAdoptRun?.(action.runId, action.step);
        return;
      case "edit-system-prompt":
        await editSystemPrompt("problem-intake.md");
        return;
    }
  }

  async function ensureRunDir(): Promise<void> {
    if (runDirReady) return;
    await invoke<CreatedRunPaths>("loop_create_run", {
      projectPath: ctx.projectPath,
      runId: ctx.runId,
    });
    runDirReady = true;
  }

  async function sendTurn(): Promise<void> {
    const userMsg = state.inputDraft.trim();
    if (!userMsg) return;
    if (state.turns.some((t) => t.pending)) return;

    // Optimistic UI: el turno aparece como pendiente.
    const turn: ChatTurn = {
      user: userMsg,
      assistant: "",
      pending: true,
    };
    state.turns.push(turn);
    state.inputDraft = "";
    refs.refresh();

    try {
      await ensureRunDir();
    } catch (err) {
      turn.pending = false;
      turn.error = `no pude crear el run dir: ${stringifyError(err)}`;
      refs.refresh();
      return;
    }

    // Si tenemos sesión activa con este CLI, mandamos sólo el mensaje nuevo —
    // el CLI ya recuerda los turnos previos. Si no, serializamos toda la
    // historia en el prompt (modo one-shot legacy, sirve de bootstrap).
    const sessionId = state.sessionByCli[state.cli];
    const prompt = sessionId
      ? userMsg
      : buildHistoryPrompt(state.turns.slice(0, -1), userMsg);

    const systemPromptPath = buildRunPromptPath(
      ctx.projectPath,
      ctx.runId,
      "problem-intake.md",
    );

    try {
      const result = await invoke<AgentResult>("run_loop_agent", {
        cli: state.cli,
        // Modelo por defecto del paso 1 — alineado con design.md ("default sin
        // perfil cargado = todo claude/opus-4-7"). Los modelos por agente se
        // configuran en Section 6 (setup del Paso 3); el chat de intake usa el
        // default fijo del CLI elegido en el selector.
        model: defaultModelFor(state.cli),
        cwd: ctx.projectPath,
        systemPromptPath,
        userInput: prompt,
        timeoutSecs: 180,
        sessionId: sessionId ?? null,
      });

      turn.pending = false;
      turn.tokensIn = result.tokensIn ?? null;
      turn.tokensOut = result.tokensOut ?? null;
      if (result.error) {
        turn.error = result.error;
        turn.assistant = result.text ?? "";
        // Si la sesión expiró o no se encuentra, dejamos que el próximo turno
        // bootstrap nuevamente con la historia completa.
        if (looksLikeSessionError(result.error)) {
          delete state.sessionByCli[state.cli];
        }
      } else {
        turn.assistant = result.text;
        if (result.sessionId) {
          state.sessionByCli[state.cli] = result.sessionId;
        }
      }
    } catch (err) {
      turn.pending = false;
      turn.error = stringifyError(err);
    }

    refs.refresh();
    await persistDraft();
  }

  async function persistDraft(): Promise<void> {
    if (!runDirReady) return;
    try {
      await invoke<void>("loop_write_run_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        file: "01-problem-draft.md",
        content: serializeDraftMarkdown(state.turns),
      });
    } catch (err) {
      // El draft es auto-save; si falla no rompemos el chat — sólo logueamos.
      console.error("loop step1: no pude guardar el draft", err);
    }
  }

  async function consolidate(): Promise<void> {
    if (state.consolidating) return;
    if (state.turns.length < 1) return;
    if (state.turns.some((t) => t.pending)) return;

    state.consolidating = true;
    refs.refresh();

    try {
      await ensureRunDir();

      // En modo sesión, el CLI ya conoce la conversación; basta la instrucción
      // final. Sin sesión, mandamos la historia completa + la instrucción.
      const sessionId = state.sessionByCli[state.cli];
      const prompt = sessionId
        ? buildConsolidateInstruction()
        : buildConsolidatePrompt(state.turns);
      const systemPromptPath = buildRunPromptPath(
        ctx.projectPath,
        ctx.runId,
        "problem-intake.md",
      );

      const result = await invoke<AgentResult>("run_loop_agent", {
        cli: state.cli,
        model: defaultModelFor(state.cli),
        cwd: ctx.projectPath,
        systemPromptPath,
        userInput: prompt,
        timeoutSecs: 180,
        sessionId: sessionId ?? null,
      });

      if (result.error) {
        throw new Error(result.error);
      }

      const finalDoc = result.text.trim();
      if (!finalDoc) {
        throw new Error("respuesta vacía del agente");
      }

      await invoke<void>("loop_write_run_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        file: "01-problem.md",
        content: finalDoc + (finalDoc.endsWith("\n") ? "" : "\n"),
      });

      state.consolidating = false;
      refs.refresh();
      ctx.onConsolidate();
    } catch (err) {
      state.consolidating = false;
      state.consolidateError = stringifyError(err);
      refs.refresh();
    }
  }

  async function editSystemPrompt(name: LoopPromptName): Promise<void> {
    // El path del prompt en el run (la copia atómica del global). Si el
    // run_dir no se creó aún, lo creamos primero para que haya un archivo
    // que abrir.
    try {
      await ensureRunDir();
    } catch (err) {
      console.error("loop step1: no pude crear run para editar prompt", err);
      return;
    }
    const path = buildRunPromptPath(ctx.projectPath, ctx.runId, name);
    try {
      await invoke<void>("open_file_in_editor", { path });
    } catch (err) {
      console.error("loop step1: no pude abrir el editor", err);
    }
  }

  return {
    dispose: () => {
      refs.cleanup();
    },
    getTurnCount: () => state.turns.length,
  };
}

// ---------------------------------------------------------------------------
// Estado interno y acciones
// ---------------------------------------------------------------------------

interface Step1State {
  turns: ChatTurn[];
  cli: LoopCli;
  inputDraft: string;
  consolidating: boolean;
  consolidateError?: string;
  /** Detectado en hidratación: ya existe un `01-problem.md` con contenido en el run dir. */
  consolidatedExists: boolean;
  /** Picker abierto / cerrado. */
  pickerOpen: boolean;
  /** Lista de runs cargada del backend (null = aún no se pidió o falló). */
  runsList: RunSummary[] | null;
  /** Spinner del picker. */
  pickerLoading: boolean;
  /**
   * Session id de cada CLI usado. Se popula con `result.sessionId` después de
   * cada turno exitoso y se reutiliza en el siguiente turno (claude `--resume`,
   * codex `exec resume`, opencode `--session`). En modo session sólo enviamos
   * el mensaje nuevo — el CLI recuerda la historia. Si cambia el CLI, usamos
   * la sesión del nuevo CLI (o arrancamos una nueva mandando historia completa
   * si nunca usamos ese CLI).
   */
  sessionByCli: Partial<Record<LoopCli, string>>;
}

type ChatAction =
  | { kind: "set-cli"; cli: LoopCli }
  | { kind: "set-input"; value: string }
  | { kind: "send" }
  | { kind: "consolidate" }
  | { kind: "skip-to-step-2" }
  | { kind: "toggle-picker" }
  | { kind: "adopt-run"; runId: string; step: 1 | 2 | 3 }
  | { kind: "edit-system-prompt" };

interface RunSummary {
  runId: string;
  lastModifiedMs: number;
  hasDraft: boolean;
  hasConsolidated: boolean;
  hasPhases: boolean;
  preview: string | null;
}

// ---------------------------------------------------------------------------
// Vista
// ---------------------------------------------------------------------------

interface ViewRefs {
  refresh(): void;
  cleanup(): void;
}

function render(
  slot: HTMLElement,
  state: Step1State,
  ctx: Step1Context,
  dispatch: (action: ChatAction) => void | Promise<void>,
): ViewRefs {
  // El slot del chrome viene con `display: flex; align-items: center` para los
  // placeholders. Cambiamos a layout vertical full-height para el chat.
  slot.classList.add("loop-step1");

  const root = document.createElement("div");
  root.className = "loop-step1-root";
  slot.replaceChildren(root);

  const handlers: Array<{
    el: EventTarget;
    type: string;
    handler: EventListenerOrEventListenerObject;
  }> = [];

  function on<T extends Event>(
    el: EventTarget,
    type: string,
    handler: (e: T) => void,
  ): void {
    const wrapped = handler as EventListenerOrEventListenerObject;
    el.addEventListener(type, wrapped);
    handlers.push({ el, type, handler: wrapped });
  }

  function refresh(): void {
    root.replaceChildren();
    root.append(renderHeader());
    if (state.pickerOpen) root.append(renderPicker());
    if (state.consolidatedExists) root.append(renderResumeBanner());
    root.append(renderTurns(), renderComposer());
  }

  function renderPicker(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step1-picker";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-label", "Runs anteriores del project");

    const header = document.createElement("div");
    header.className = "loop-step1-picker-header";
    const title = document.createElement("strong");
    title.textContent = "Runs anteriores";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "loop-btn loop-btn-ghost";
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Cerrar picker");
    on(closeBtn, "click", () => {
      void dispatch({ kind: "toggle-picker" });
    });
    header.append(title, closeBtn);
    wrap.append(header);

    if (state.pickerLoading) {
      const p = document.createElement("p");
      p.className = "loop-step1-picker-empty";
      p.textContent = "cargando runs…";
      wrap.append(p);
      return wrap;
    }
    const list = state.runsList ?? [];
    if (list.length === 0) {
      const p = document.createElement("p");
      p.className = "loop-step1-picker-empty";
      p.textContent = "no hay runs anteriores en este project.";
      wrap.append(p);
      return wrap;
    }

    const ul = document.createElement("ul");
    ul.className = "loop-step1-picker-list";
    for (const run of list) {
      // Saltamos el run actual — no tiene sentido "adoptar" el que ya estás usando.
      if (run.runId === ctx.runId) continue;
      ul.append(renderPickerItem(run));
    }
    if (ul.children.length === 0) {
      const p = document.createElement("p");
      p.className = "loop-step1-picker-empty";
      p.textContent = "el único run que existe es el actual.";
      wrap.append(p);
    } else {
      wrap.append(ul);
    }
    return wrap;
  }

  function renderPickerItem(run: RunSummary): HTMLElement {
    const li = document.createElement("li");
    li.className = "loop-step1-picker-item";

    const main = document.createElement("button");
    main.type = "button";
    main.className = "loop-step1-picker-item-main";

    const preview = document.createElement("div");
    preview.className = "loop-step1-picker-item-preview";
    preview.textContent = run.preview ?? "(sin preview)";

    const meta = document.createElement("div");
    meta.className = "loop-step1-picker-item-meta";
    const date = new Date(run.lastModifiedMs);
    const dateText = isFinite(date.getTime())
      ? date.toLocaleString()
      : "(fecha desconocida)";
    const flags: string[] = [];
    if (run.hasDraft) flags.push("draft");
    if (run.hasConsolidated) flags.push("consolidado");
    if (run.hasPhases) flags.push("fases");
    meta.textContent = `${dateText} · ${flags.join(" · ") || "vacío"} · ${run.runId.slice(0, 8)}`;

    main.append(preview, meta);
    on(main, "click", () => {
      // Elegimos el paso de destino según qué archivos haya en el run:
      // si ya hay fases generadas → paso 3 directo (setup), si hay consolidado
      // → paso 2, si sólo hay draft → paso 1.
      const step: 1 | 2 | 3 = run.hasPhases ? 3 : run.hasConsolidated ? 2 : 1;
      void dispatch({ kind: "adopt-run", runId: run.runId, step });
    });

    li.append(main);
    return li;
  }

  function renderResumeBanner(): HTMLElement {
    const banner = document.createElement("div");
    banner.className = "loop-step1-resume-banner";
    banner.setAttribute("role", "status");

    const text = document.createElement("span");
    text.className = "loop-step1-resume-banner-text";
    text.textContent = "Ya hay un 01-problem.md consolidado en este run.";

    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "loop-btn loop-btn-primary";
    skip.textContent = "→ ir al paso 2";
    skip.title = "Saltar al paso 2 usando el 01-problem.md existente";
    on(skip, "click", () => {
      void dispatch({ kind: "skip-to-step-2" });
    });

    banner.append(text, skip);
    return banner;
  }

  function cleanup(): void {
    for (const { el, type, handler } of handlers) {
      el.removeEventListener(type, handler);
    }
    handlers.length = 0;
    slot.classList.remove("loop-step1");
  }

  function renderHeader(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step1-header";

    const title = document.createElement("div");
    title.className = "loop-step1-title";
    title.textContent = "Paso 1 · refinar el problema";

    const editPrompt = document.createElement("button");
    editPrompt.type = "button";
    editPrompt.className = "loop-btn loop-btn-ghost loop-step1-edit-prompt";
    editPrompt.textContent = "✎ editar prompt de sistema";
    editPrompt.title = "Abre problem-intake.md del run en el editor del sistema";
    on(editPrompt, "click", () => {
      void dispatch({ kind: "edit-system-prompt" });
    });

    const actions = document.createElement("div");
    actions.className = "loop-step1-header-actions";

    if (ctx.onAdoptRun) {
      const picker = document.createElement("button");
      picker.type = "button";
      picker.className = "loop-btn loop-btn-ghost";
      picker.textContent = state.pickerOpen ? "↺ runs anteriores ✓" : "↺ runs anteriores";
      picker.title = "Listar runs previos del project para retomar uno";
      on(picker, "click", () => {
        void dispatch({ kind: "toggle-picker" });
      });
      actions.append(picker);
    }
    actions.append(editPrompt);

    wrap.append(title, actions);
    return wrap;
  }

  function renderTurns(): HTMLElement {
    const list = document.createElement("div");
    list.className = "loop-step1-turns";

    if (state.turns.length === 0) {
      const empty = document.createElement("p");
      empty.className = "loop-step1-empty";
      empty.textContent =
        "Contame el problema en el que estás trabajando. El agente hará preguntas hasta que esté listo para descomponerlo en fases.";
      list.appendChild(empty);
      return list;
    }

    for (const turn of state.turns) {
      list.append(renderTurn(turn));
    }
    // Autoscroll al final cuando se agregan turnos. Diferido al próximo frame
    // para que el DOM esté layouteado antes de medir.
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
    return list;
  }

  function renderTurn(turn: ChatTurn): HTMLElement {
    const block = document.createElement("article");
    block.className = "loop-step1-turn";

    const userRow = document.createElement("div");
    userRow.className = "loop-step1-row loop-step1-row-user";
    const userLabel = document.createElement("span");
    userLabel.className = "loop-step1-rolelabel";
    userLabel.textContent = "vos";
    const userText = document.createElement("div");
    userText.className = "loop-step1-msg";
    userText.textContent = turn.user;
    userRow.append(userLabel, userText);

    const agentRow = document.createElement("div");
    agentRow.className = "loop-step1-row loop-step1-row-agent";
    const agentLabel = document.createElement("span");
    agentLabel.className = "loop-step1-rolelabel";
    agentLabel.textContent = state.cli;
    const agentText = document.createElement("div");
    agentText.className = "loop-step1-msg";
    if (turn.pending) {
      agentText.classList.add("loop-step1-msg-pending");
      agentText.textContent = "pensando…";
    } else if (turn.error) {
      // Si hubo error mostramos lo que tenemos (si algo) + nota de error
      // debajo. Esto facilita que el usuario vea respuestas parciales.
      if (turn.assistant) {
        agentText.textContent = turn.assistant;
      } else {
        agentText.classList.add("loop-step1-msg-empty");
        agentText.textContent = "(sin respuesta)";
      }
    } else {
      agentText.textContent = turn.assistant;
    }
    agentRow.append(agentLabel, agentText);

    block.append(userRow, agentRow);

    if (turn.error) {
      const err = document.createElement("p");
      err.className = "loop-step1-turn-error";
      err.textContent = `error: ${turn.error}`;
      block.append(err);
    }

    if (turn.tokensIn != null || turn.tokensOut != null) {
      const meta = document.createElement("p");
      meta.className = "loop-step1-turn-meta";
      const parts: string[] = [];
      if (turn.tokensIn != null) parts.push(`in ${turn.tokensIn}`);
      if (turn.tokensOut != null) parts.push(`out ${turn.tokensOut}`);
      meta.textContent = parts.join(" · ");
      block.append(meta);
    }

    return block;
  }

  function renderComposer(): HTMLElement {
    const composer = document.createElement("div");
    composer.className = "loop-step1-composer";

    // Fila superior: selector de CLI, info, botón consolidar
    const toolbar = document.createElement("div");
    toolbar.className = "loop-step1-toolbar";

    const cliWrap = document.createElement("label");
    cliWrap.className = "loop-step1-cli-wrap";
    const cliLbl = document.createElement("span");
    cliLbl.className = "loop-step1-cli-label";
    cliLbl.textContent = "CLI";
    const cliSelect = document.createElement("select");
    cliSelect.className = "loop-step1-cli-select";
    for (const opt of ["claude", "codex", "opencode"] as const) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      if (opt === state.cli) o.selected = true;
      cliSelect.appendChild(o);
    }
    on(cliSelect, "change", () => {
      const v = cliSelect.value as LoopCli;
      void dispatch({ kind: "set-cli", cli: v });
    });
    cliWrap.append(cliLbl, cliSelect);

    const spacer = document.createElement("div");
    spacer.className = "loop-step1-toolbar-spacer";

    const consolidate = document.createElement("button");
    consolidate.type = "button";
    consolidate.className = "loop-btn loop-btn-primary loop-step1-consolidate";
    consolidate.textContent = state.consolidating
      ? "consolidando…"
      : "✓ consolidar problema.md →";
    const hasTurn = state.turns.length > 0;
    const anyPending = state.turns.some((t) => t.pending);
    consolidate.disabled = !hasTurn || anyPending || state.consolidating;
    if (!hasTurn) {
      consolidate.title = "Necesitás al menos un turno antes de consolidar.";
    } else if (anyPending) {
      consolidate.title = "Esperá a que el último turno termine.";
    }
    on(consolidate, "click", () => {
      void dispatch({ kind: "consolidate" });
    });

    toolbar.append(cliWrap, spacer, consolidate);

    // Mensaje de error de consolidación, si lo hay
    let errEl: HTMLElement | null = null;
    if (state.consolidateError) {
      errEl = document.createElement("p");
      errEl.className = "loop-step1-consolidate-error";
      errEl.textContent = `error al consolidar: ${state.consolidateError}`;
    }

    // Fila inferior: textarea + botón "enviar"
    const inputRow = document.createElement("form");
    inputRow.className = "loop-step1-input-row";
    inputRow.setAttribute("aria-label", "enviar mensaje");

    const textarea = document.createElement("textarea");
    textarea.className = "loop-step1-input";
    textarea.placeholder =
      "describí el problema o respondé al agente… (Cmd+Enter para enviar)";
    textarea.rows = 4;
    textarea.value = state.inputDraft;
    const inFlight = anyPending || state.consolidating;
    textarea.disabled = inFlight;

    on(textarea, "input", () => {
      void dispatch({ kind: "set-input", value: textarea.value });
    });
    on(textarea, "keydown", (e: KeyboardEvent) => {
      // Cmd+Enter / Ctrl+Enter envía. Section 10.3 puede unificar atajos.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        // Persistimos lo último del textarea antes de submit (en caso de que
        // el evento "input" no se haya disparado por race del IME).
        state.inputDraft = textarea.value;
        void dispatch({ kind: "send" });
      }
    });

    const send = document.createElement("button");
    send.type = "submit";
    send.className = "loop-btn loop-btn-primary loop-step1-send";
    send.textContent = "enviar";
    send.disabled = inFlight || textarea.value.trim().length === 0;

    on(inputRow, "submit", (e: Event) => {
      e.preventDefault();
      state.inputDraft = textarea.value;
      void dispatch({ kind: "send" });
    });
    // Habilitar/deshabilitar el botón mientras tipean sin re-render del root.
    on(textarea, "input", () => {
      send.disabled = inFlight || textarea.value.trim().length === 0;
    });

    inputRow.append(textarea, send);

    composer.append(toolbar);
    if (errEl) composer.append(errEl);
    composer.append(inputRow);

    return composer;
  }

  // Render inicial
  refresh();
  // Suprimimos warnings de variables no usadas: `ctx` se cierra sobre via dispatch.
  void ctx;

  return { refresh, cleanup };
}

// ---------------------------------------------------------------------------
// Serialización de historia y prompts
// ---------------------------------------------------------------------------

/**
 * Construye el prompt one-shot que se manda al CLI en cada turno. Incluye los
 * turnos previos como historia textual, en orden, y el mensaje actual del
 * usuario al final. El system prompt (con instrucciones del modo "intake") lo
 * pasa `run_loop_agent` via `--append-system-prompt`.
 *
 * Formato pensado para ser fácil de leer en un solo string — los CLIs no
 * necesitan estructura ChatML; tratan todo como un prompt de usuario y
 * generan la respuesta del agente. El header explícito ayuda al modelo a
 * entender el rol de cada bloque.
 */
function buildHistoryPrompt(history: ChatTurn[], currentUser: string): string {
  const parts: string[] = [];
  if (history.length > 0) {
    parts.push("# Conversación previa\n");
    for (const turn of history) {
      parts.push(`## Usuario\n${turn.user.trim()}\n`);
      const assistant = turn.assistant.trim();
      if (assistant) parts.push(`## Agente\n${assistant}\n`);
    }
  }
  parts.push("# Mensaje actual del usuario\n");
  parts.push(currentUser.trim());
  parts.push(
    "\n\nRespondé al usuario continuando la conversación. No repitas la historia; respondé sólo al mensaje actual.",
  );
  return parts.join("\n");
}

/**
 * Prompt final para consolidar el problema en un `01-problem.md` estructurado.
 * Pide explícitamente el formato esperado para que el output sea
 * directamente persistible sin parseo posterior.
 */
function buildConsolidatePrompt(history: ChatTurn[]): string {
  const parts: string[] = [];
  parts.push("# Conversación completa\n");
  for (const turn of history) {
    parts.push(`## Usuario\n${turn.user.trim()}\n`);
    const assistant = turn.assistant.trim();
    if (assistant) parts.push(`## Agente\n${assistant}\n`);
  }
  parts.push("# Tarea\n");
  parts.push(buildConsolidateInstruction());
  return parts.join("\n");
}

/**
 * Instrucción pura de consolidación sin la historia. Se usa cuando el CLI ya
 * tiene la conversación cargada en sesión (`--resume`/`exec resume`/`--session`).
 */
function buildConsolidateInstruction(): string {
  return (
    "Basándote en la conversación previa, generá un único documento Markdown con el resumen estructurado del problema. Estructura esperada:\n\n" +
    "```\n" +
    "# Problema\n\n" +
    "## Contexto\n\n## Objetivo\n\n## Restricciones\n\n## Criterios de éxito\n\n## Riesgos conocidos\n" +
    "```\n\n" +
    "Devolvé sólo el contenido Markdown final (sin code fences, sin preámbulo). Estilo conciso, castellano rioplatense, sin emojis."
  );
}

/**
 * Heurística para detectar mensajes de error que indican sesión inválida o
 * expirada. En ese caso limpiamos el session id local para forzar bootstrap
 * fresh (con historia serializada) en el próximo turno.
 */
function looksLikeSessionError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("session") &&
    (lower.includes("not found") ||
      lower.includes("expired") ||
      lower.includes("invalid") ||
      lower.includes("no encontrad") ||
      lower.includes("no existe"))
  );
}

/** Serializa los turnos a un Markdown legible para `01-problem-draft.md`. */
function serializeDraftMarkdown(turns: ChatTurn[]): string {
  const parts: string[] = ["# Draft del problema (auto-save)\n"];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    parts.push(`## Turno ${i + 1}\n`);
    parts.push(`### Usuario\n${turn.user.trim()}\n`);
    if (turn.assistant.trim()) {
      parts.push(`### Agente\n${turn.assistant.trim()}\n`);
    }
    if (turn.error) {
      parts.push(`> error: ${turn.error}\n`);
    }
  }
  return parts.join("\n");
}

/**
 * Parser inverso del draft. Tolerante: si el formato no matchea exactamente
 * (ej. el usuario lo editó a mano), devolvemos lo que pudimos extraer. Si no
 * hay nada parseable, devolvemos lista vacía.
 *
 * Section 9 (resume) puede reemplazar esto por un schema más estricto basado
 * en `state.json`; por ahora el round-trip simple alcanza.
 */
function parseDraftMarkdown(content: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const turnBlocks = content.split(/^## Turno \d+$/m).slice(1);
  for (const block of turnBlocks) {
    const userMatch = block.match(/### Usuario\n([\s\S]*?)(?=\n### Agente|$)/);
    const agentMatch = block.match(/### Agente\n([\s\S]*?)(?=\n> error:|$)/);
    if (!userMatch) continue;
    const user = userMatch[1].trim();
    if (!user) continue;
    turns.push({
      user,
      assistant: agentMatch ? agentMatch[1].trim() : "",
      pending: false,
    });
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRunPromptPath(
  projectPath: string,
  runId: string,
  name: LoopPromptName,
): string {
  // El backend (`loop_create_run`) usa `<project>/.loop/runs/<runId>/prompts/`.
  // Reproducimos el join acá para pasar el path absoluto a `run_loop_agent`.
  // Validamos contra LOOP_PROMPT_NAMES por tipo, no runtime — el llamador
  // siempre pasa una constante del set.
  void LOOP_PROMPT_NAMES;
  // Normalizamos separadores para que funcione en macOS/Linux. Tauri en
  // Windows tolera "/" en la mayoría de los APIs, pero por las dudas dejamos
  // el join nativo del SO si está disponible.
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return [projectPath, ".loop", "runs", runId, "prompts", name].join(sep);
}

function defaultModelFor(cli: LoopCli): string {
  // Defaults razonables por CLI. Section 6 (setup del Paso 3) permite
  // overrides per-agente; el chat de intake usa el default fijo del CLI
  // elegido — no exponemos selector de modelo en el paso 1 para mantener
  // la superficie chica.
  switch (cli) {
    case "claude":
      return "claude-opus-4-7";
    case "codex":
      return "gpt-5";
    case "opencode":
      return "anthropic/claude-sonnet-4-5";
  }
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
