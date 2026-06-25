// Vista chrome de la ventana /loop: header persistente + slot para los pasos.
//
// Sigue el patrón de los paneles de workspaces (ver
// `src/modules/workspaces/panel/workspaces-panel.ts`): el módulo expone
// `mountLoopChrome(root, router)` que se suscribe al router y re-renderiza
// imperativamente con `replaceChildren`. No introducimos framework; mantenemos
// coherencia con el resto del app.
//
// Los componentes de cada paso (1=chat, 2=phases, 3=setup+engine) los montan
// secciones posteriores dentro del slot `#loop-step-slot` que esta función
// crea. Por ahora colocamos placeholders descriptivos para que el chrome sea
// inspeccionable end-to-end.

import { mountStep1Chat, type Step1Handle } from "./step1-chat";
import { mountStep2Phases, type Step2Handle, parsePhasesManifest } from "./step2-phases";
import { mountStep3Run, type Step3RunHandle } from "./step3-run";
import { mountStep3Setup, type RunConfig, type Step3Handle } from "./step3-setup";
import { attachRunNotifier, type NotifierHandle } from "./run-notifier";
import { RunScheduler } from "./state/run-scheduler";
import { confirmModal } from "../../shared/ui/modal";
import { showToast } from "../../shared/ui/toast";
import {
  archiveRun,
  discardPartialOutputs,
  listInterruptedRuns,
  loadInterruptedRunDetails,
  rewindRunningStages,
  type InterruptedRunDetails,
} from "./state/resume-detector";
import type { LoopRouter, LoopRouterState, LoopStep } from "./state/run-context";
import { invoke } from "@tauri-apps/api/core";

export interface LoopChromeHandle {
  dispose(): void;
}

/**
 * Identidad del slot del paso para evitar re-montajes innecesarios. El chat
 * del paso 1 (Section 4) mantiene historia in-memory; si el chrome se
 * re-renderiza por un focus refresh del router, no queremos perder los
 * turnos. Sólo re-montamos el slot cuando cambia (runId, step, view) — la
 * transición entre projects ya regenera el runId vía `LoopRouter.refresh`.
 *
 * `view` distingue las 2 sub-vistas del paso 3:
 * Step 3 monta `step3-setup.ts` (configuración pre-ejecución) y step 4 monta
 * `step3-run.ts` (timeline del run en ejecución). El scheduler vive sólo
 * mientras estamos en step 4; pasos 1/2/3 lo descartan al re-montar.
 */
interface MountedStep {
  runId: string;
  step: LoopStep;
  handle: Step1Handle | Step2Handle | Step3Handle | Step3RunHandle | null;
  /** Scheduler vivo cuando estamos en step 4. null en cualquier otro paso. */
  scheduler: RunScheduler | null;
  /**
   * Section 10.1 — handle del notifier que escucha el scheduler y emite toasts.
   * Vive sólo mientras `scheduler !== null`. Lo disponemos junto al scheduler
   * en `dispose()` o cuando re-montamos el slot.
   */
  notifier: NotifierHandle | null;
}

/**
 * Monta el chrome dentro del contenedor dado (típicamente `#loop-root` del
 * `loop.html`). Devuelve un handle para limpiar listeners si la ventana se
 * destruye — equivalente al patrón de `mountLoopButton` en `loop-window.ts`.
 */
/**
 * Section 9: ID compuesto que identifica la última detección de runs
 * interrumpidos para un project. Lo usamos para no re-escanear el FS en cada
 * focus refresh del router — sólo cuando cambia el project activo.
 */
interface ResumeProbe {
  projectPath: string;
  /** Resultado de la última detección. null = ya se decidió (retomar/archivar/dismiss). */
  pending: InterruptedRunDetails | null;
  /** True si el scan ya corrió para este project. False = pendiente de scan. */
  scanned: boolean;
}

export function mountLoopChrome(root: HTMLElement, router: LoopRouter): LoopChromeHandle {
  let mountedStep: MountedStep | null = null;
  /**
   * Section 9: cache del último scan de runs interrumpidos. Lo invalidamos
   * cuando cambia `projectPath` (transición de gate o cambio del project
   * activo). El banner se monta una sola vez por project — si el usuario lo
   * descarta, `pending=null` y no aparece más hasta que cambie de project.
   */
  let resumeProbe: ResumeProbe | null = null;

  const handleExecuteRun = (config: RunConfig): void => {
    if (!mountedStep || mountedStep.step !== 3) return;
    const state = router.getState();
    if (state.status !== "active") return;
    // 1) Cambiar el step del router → la subscription re-renderiza con
    //    state.step=4, mostrando un placeholder vacío.
    // 2) Disparar switchToRunView async para montar el scheduler + view
    //    encima del placeholder. El `commit` callback actualiza mountedStep
    //    a {step:4, handle, scheduler, notifier}.
    router.setStep(4);
    const next = router.getState();
    if (next.status !== "active") return;
    void switchToRunView(root, router, next, config, mountedStep, (committed) => {
      mountedStep = committed;
    });
  };

  const rerender = (): void => {
    const state = router.getState();
    mountedStep = render(root, router, state, mountedStep, handleExecuteRun, resumeProbe);
  };

  const unsubscribe = router.on((state) => {
    if (state.status === "active") {
      // ¿Hay que escanear? Sólo si el project cambió o nunca escaneamos.
      if (!resumeProbe || resumeProbe.projectPath !== state.project.path) {
        resumeProbe = { projectPath: state.project.path, pending: null, scanned: false };
        void probeForInterruptedRun(state.project.path).then((details) => {
          // Sólo aplicamos si seguimos en el mismo project — el usuario
          // pudo haber cambiado mientras el scan estaba en vuelo.
          if (resumeProbe && resumeProbe.projectPath === state.project.path) {
            resumeProbe.pending = details;
            resumeProbe.scanned = true;
            rerender();
          }
        });
      }
    } else {
      resumeProbe = null;
    }
    mountedStep = render(root, router, state, mountedStep, handleExecuteRun, resumeProbe);
  });

  const handleResumeAction = async (action: "retomar" | "archivar" | "dismiss"): Promise<void> => {
    if (!resumeProbe?.pending) return;
    const details = resumeProbe.pending;
    const state = router.getState();
    if (state.status !== "active") return;
    if (action === "archivar") {
      try {
        await archiveRun(state.project.path, details.summary.runId);
      } catch (err) {
        console.error("loop chrome: archivar run falló", err);
        showToast(`No pude archivar el run: ${stringifyError(err)}`, "error");
        return;
      }
      resumeProbe.pending = null;
      showToast("run archivado", "info");
      rerender();
      return;
    }
    if (action === "dismiss") {
      resumeProbe.pending = null;
      rerender();
      return;
    }
    // action === "retomar"
    try {
      await resumeInterruptedRun(root, state, details, router, (next) => {
        mountedStep = next;
      });
      if (resumeProbe) resumeProbe.pending = null;
    } catch (err) {
      console.error("loop chrome: retomar run falló", err);
      showToast(`No pude retomar el run: ${stringifyError(err)}`, "error");
    }
  };

  // Adjuntamos el handler al chrome a través de un dataset hook que renderResumeBanner
  // lee al re-bindear los listeners de los botones. Esto evita closures que
  // capturan refs viejos del MountedStep.
  resumeActionHandler = handleResumeAction;

  return {
    dispose: () => {
      unsubscribe();
      if (mountedStep?.handle) mountedStep.handle.dispose();
      if (mountedStep?.notifier) mountedStep.notifier.dispose();
      if (mountedStep?.scheduler) mountedStep.scheduler.abort();
      mountedStep = null;
      resumeActionHandler = null;
    },
  };
}

/**
 * Section 9.4 — escanea el project buscando un run interrumpido y, si lo
 * encuentra, carga su state.json para validarlo. Devuelve el primer run
 * retomable (típicamente sólo hay uno; si hay más, el banner muestra el más
 * reciente — la lista del backend ya viene ordenada por heartbeat desc).
 *
 * Si el state.json está corrupto, lo intentamos con el siguiente. Si ninguno
 * pasa la validación, devolvemos null y el banner no aparece — el usuario va
 * a ver el flow normal del paso 1.
 */
async function probeForInterruptedRun(projectPath: string): Promise<InterruptedRunDetails | null> {
  try {
    const list = await listInterruptedRuns(projectPath);
    for (const summary of list) {
      const details = await loadInterruptedRunDetails(projectPath, summary);
      if (details) return details;
    }
  } catch (err) {
    console.error("loop chrome: probe de runs interrumpidos falló", err);
  }
  return null;
}

/**
 * Module-scoped handler para los botones del banner. Se setea en
 * `mountLoopChrome` y se referencia desde `renderResumeBanner`. Mantenemos un
 * solo handler global porque sólo hay una instancia del chrome por ventana.
 */
let resumeActionHandler: ((action: "retomar" | "archivar" | "dismiss") => Promise<void>) | null =
  null;

function render(
  root: HTMLElement,
  router: LoopRouter,
  state: LoopRouterState,
  prev: MountedStep | null,
  onExecuteRun: (config: RunConfig) => void,
  resumeProbe: ResumeProbe | null,
): MountedStep | null {
  // Al salir de "active" o cambiar de runId/step, hay que desmontar el handle
  // del step anterior para no leakear listeners del chat.
  function disposePrev(): void {
    if (prev?.handle) prev.handle.dispose();
  }

  root.classList.add("loop-root");

  switch (state.status) {
    case "loading":
      disposePrev();
      root.replaceChildren(renderLoading());
      return null;
    case "no-project":
      disposePrev();
      root.replaceChildren(renderNoProjectGate());
      return null;
    case "invalid-path":
      disposePrev();
      root.replaceChildren(renderInvalidPathGate(state.project.name, state.project.path));
      return null;
    case "active":
      return renderActive(root, router, state, prev, onExecuteRun, resumeProbe);
  }
}

function renderActive(
  root: HTMLElement,
  router: LoopRouter,
  state: Extract<LoopRouterState, { status: "active" }>,
  prev: MountedStep | null,
  onExecuteRun: (config: RunConfig) => void,
  resumeProbe: ResumeProbe | null,
): MountedStep {
  // Si seguimos en el mismo (runId, step), sólo refrescamos el header — el
  // slot del paso ya está montado con su estado interno (chat con sus turnos,
  // scheduler corriendo, etc.).
  const sameSlot = prev && prev.runId === state.runId && prev.step === state.step;
  if (sameSlot) {
    const shell = root.querySelector(".loop-shell");
    const header = root.querySelector(".loop-header");
    if (shell && header) {
      header.replaceWith(renderHeader(router, state, prev));
      reconcileResumeBanner(shell, resumeProbe);
      return prev;
    }
    // Fallback: si por alguna razón el DOM no está como esperamos, caemos al
    // re-render completo.
  }

  if (prev?.handle) prev.handle.dispose();
  if (prev?.notifier) prev.notifier.dispose();
  // No abortamos el scheduler si vamos hacia step 4 — el caller (handleExecuteRun
  // o resumeInterruptedRun) lo monta inmediatamente después. Sí abortamos en
  // transiciones entre otros pasos.
  if (prev?.scheduler && state.step !== 4) prev.scheduler.abort();

  const shell = document.createElement("div");
  shell.className = "loop-shell";
  const header = renderHeader(router, state, prev);
  const slot = renderStepSlot(state.step);
  shell.append(header, slot);
  reconcileResumeBanner(shell, resumeProbe);
  root.replaceChildren(shell);

  let handle: Step1Handle | Step2Handle | Step3Handle | Step3RunHandle | null = null;
  if (state.step === 1) {
    slot.replaceChildren();
    handle = mountStep1Chat(slot, {
      projectPath: state.project.path,
      runId: state.runId,
      onConsolidate: () => router.setStep(2),
      onAdoptRun: (runId, step) => router.adoptRunId(runId, step),
    });
  } else if (state.step === 2) {
    slot.replaceChildren();
    handle = mountStep2Phases(slot, {
      projectPath: state.project.path,
      runId: state.runId,
      onAdvance: () => router.setStep(3),
    });
  } else if (state.step === 3) {
    slot.replaceChildren();
    handle = mountStep3Setup(slot, {
      projectPath: state.project.path,
      projectName: state.project.name,
      suggestedCli: state.project.activeCliId ?? null,
      runId: state.runId,
      onExecuteRun,
    });
  }

  return {
    runId: state.runId,
    step: state.step,
    handle,
    scheduler: null,
    notifier: null,
  };
}

/**
 * Switch del slot del paso 3 desde la vista "setup" a la vista "run". Lee las
 * fases del run desde `02-phases.md`, crea el scheduler con la matriz +
 * settings que pasó el setup, inicializa la vista del timeline y arranca el
 * scheduler.
 *
 * Sigue siendo "imperativo": no introducimos un store global del scheduler —
 * el scheduler vive sólo mientras el step 3 esté montado en vista "run". Si
 * el usuario navega afuera (paso 1/2, abandonar run, cierra ventana) lo
 * abortamos en el `dispose()` del MountedStep correspondiente.
 */
async function switchToRunView(
  root: HTMLElement,
  router: LoopRouter,
  state: Extract<LoopRouterState, { status: "active" }>,
  config: RunConfig,
  prev: MountedStep,
  commit: (next: MountedStep) => void,
): Promise<void> {
  // Leer fases desde el manifest persistido por el paso 2.
  let phases: ReturnType<typeof parsePhasesManifest> = [];
  try {
    const manifest = await invoke<string>("loop_read_run_file", {
      projectPath: state.project.path,
      runId: state.runId,
      file: "02-phases.md",
    });
    phases = manifest.trim() ? parsePhasesManifest(manifest) : [];
  } catch (err) {
    console.error("loop chrome: no pude leer 02-phases.md", err);
  }

  if (phases.length === 0) {
    // Sin fases no se puede ejecutar — volvemos al setup y mostramos un toast.
    // La validación en step3-setup ya cubre el caso happy-path
    // (canExecute exige phases.length > 0), así que esto es una salvaguarda.
    showToast(
      "No hay fases para ejecutar — volvé al Paso 2 para descomponer el problema.",
      "error",
    );
    // Sacamos al usuario del paso 4 (slot vacío) volviendo al setup.
    router.setStep(3);
    return;
  }

  // Disponer del setup actual y abrir el slot para la nueva vista.
  if (prev.handle) prev.handle.dispose();

  const shell = root.querySelector(".loop-shell");
  if (!shell) return;
  const oldSlot = shell.querySelector("#loop-step-slot");
  const newSlot = renderStepSlot(4);
  if (oldSlot) oldSlot.replaceWith(newSlot);
  else shell.appendChild(newSlot);

  const scheduler = new RunScheduler();
  scheduler.initialize(
    phases,
    {
      projectPath: state.project.path,
      runId: state.runId,
      matrix: config.matrix,
      promptOverrides: config.promptOverrides,
      maxRetries: config.config.maxRetries,
      // 300s alineado con default del backend; setup del paso 3 todavía no expone
      // el override per-run. Section 8/9+ pueden agregarlo si hace falta.
      agentTimeoutSecs: 300,
    },
    // Section 8: el modo viene del RunConfig (effectiveMode ya degradó
    // "híbrido" a "sequential" si el DAG es lineal — ver step3-setup).
    config.mode,
  );

  const handle = mountStep3Run(newSlot, {
    scheduler,
    projectName: state.project.name,
  });

  // Section 10.1 — toasts auxiliares (run completado, warning, conflict).
  // Lo adjuntamos después de mountStep3Run para que el view se suscriba
  // primero y reciba el estado inicial sin ruido de toasts.
  const notifier = attachRunNotifier(scheduler);

  commit({
    runId: state.runId,
    step: 4,
    handle,
    scheduler,
    notifier,
  });

  // Arrancar el ciclo. El scheduler emite estado por el listener — el view ya
  // se está suscribiendo y va a re-renderizar en cada cambio. void el promise
  // porque el ciclo dura todo el run.
  void scheduler.start();
}

/**
 * Section 9.5 — banner "run interrumpido detectado · ¿retomar?". Lo
 * insertamos entre el header y el slot del paso. Si no hay run pendiente, la
 * función devuelve null y `reconcileResumeBanner` retira un banner previo.
 */
function renderResumeBanner(details: InterruptedRunDetails): HTMLElement {
  const banner = document.createElement("section");
  banner.className = "loop-resume-banner";
  banner.dataset.runId = details.summary.runId;
  // Section 10.6 — a11y. El banner es una notificación pasiva (live region).
  banner.setAttribute("role", "region");
  banner.setAttribute("aria-label", "run interrumpido detectado");
  banner.setAttribute("aria-live", "polite");

  const icon = document.createElement("span");
  icon.className = "loop-resume-banner-icon";
  icon.textContent = "⏸";
  icon.setAttribute("aria-hidden", "true");

  const body = document.createElement("div");
  body.className = "loop-resume-banner-body";

  const title = document.createElement("p");
  title.className = "loop-resume-banner-title";
  title.textContent = "run interrumpido detectado · ¿retomar?";

  const meta = document.createElement("p");
  meta.className = "loop-resume-banner-meta";
  const ageLabel = describeAge(details.summary.ageMs);
  const stage = details.state.currentStage ? ` · ${details.state.currentStage} en curso` : "";
  const phaseLabel =
    details.state.currentPhaseIndex >= 0 && details.state.phases[details.state.currentPhaseIndex]
      ? ` · fase ${details.state.phases[details.state.currentPhaseIndex].id}`
      : "";
  meta.textContent = `run ${shortRunId(details.summary.runId)}${phaseLabel}${stage} · último heartbeat ${ageLabel}`;

  body.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "loop-resume-banner-actions";

  const resume = document.createElement("button");
  resume.type = "button";
  resume.className = "loop-btn loop-btn-primary";
  resume.textContent = "retomar";
  resume.dataset.resumeAction = "retomar";
  resume.setAttribute("aria-label", "retomar el run interrumpido");

  const archive = document.createElement("button");
  archive.type = "button";
  archive.className = "loop-btn loop-btn-ghost";
  archive.textContent = "archivar";
  archive.dataset.resumeAction = "archivar";
  archive.setAttribute("aria-label", "archivar el run interrumpido");

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "loop-btn loop-btn-ghost loop-resume-banner-dismiss";
  dismiss.textContent = "×";
  dismiss.title = "ocultar este banner (no archiva ni borra)";
  dismiss.setAttribute("aria-label", "ocultar banner de resume");
  dismiss.dataset.resumeAction = "dismiss";

  // Los handlers se setean en `reconcileResumeBanner` después de insertar el
  // banner en el DOM — así evitamos capturar refs viejos del MountedStep si
  // el chrome se re-renderiza.
  actions.append(resume, archive, dismiss);
  banner.append(icon, body, actions);
  return banner;
}

/**
 * Section 9.5 — inserta/actualiza/elimina el banner de resume al inicio del
 * shell (después del header). Centraliza la decisión para que tanto el
 * fast-path (sameSlot) como el full-render lo apliquen igual.
 */
function reconcileResumeBanner(shell: Element, resumeProbe: ResumeProbe | null): void {
  const existing = shell.querySelector<HTMLElement>(".loop-resume-banner");
  if (!resumeProbe?.pending) {
    if (existing) existing.remove();
    return;
  }
  const details = resumeProbe.pending;
  if (existing && existing.dataset.runId === details.summary.runId) {
    // Banner ya está al día; reconectamos handlers por si el render previo
    // cleared el closure.
    bindResumeBannerHandlers(existing);
    return;
  }
  const banner = renderResumeBanner(details);
  if (existing) existing.replaceWith(banner);
  else {
    // Insertar después del header (primer hijo).
    const header = shell.querySelector(".loop-header");
    if (header && header.nextSibling) {
      shell.insertBefore(banner, header.nextSibling);
    } else if (header) {
      shell.appendChild(banner);
    } else {
      shell.insertBefore(banner, shell.firstChild);
    }
  }
  bindResumeBannerHandlers(banner);
}

function bindResumeBannerHandlers(banner: HTMLElement): void {
  const buttons = banner.querySelectorAll<HTMLButtonElement>("button[data-resume-action]");
  for (const btn of buttons) {
    const action = btn.dataset.resumeAction as "retomar" | "archivar" | "dismiss" | undefined;
    if (!action) continue;
    btn.onclick = () => {
      if (!resumeActionHandler) return;
      // Bloquear el botón mientras corre la acción para evitar dobles clicks.
      const all = banner.querySelectorAll<HTMLButtonElement>("button");
      for (const b of all) b.disabled = true;
      void resumeActionHandler(action).finally(() => {
        for (const b of all) b.disabled = false;
      });
    };
  }
}

function describeAge(ageMs: number): string {
  if (ageMs < 0) return "hace instantes";
  if (ageMs === Number.MAX_SAFE_INTEGER || ageMs > 1_000_000_000_000) return "sin heartbeat";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  return `hace ${h}h`;
}

/**
 * Section 9.6 — retoma un run interrumpido. Pasos:
 *   1. Descartar outputs parciales (archivos `<agent>.md` sin `.diff` companion).
 *   2. Hidratar el scheduler con el state persistido (degradando stages
 *      running a pending vía `rewindRunningStages`).
 *   3. Cambiar la vista del paso 3 a "run" — el usuario ve el timeline con
 *      el estado restaurado.
 *   4. Llamar `scheduler.start()` para relanzar el ciclo desde el último
 *      agente incompleto.
 *
 * NO sincronizamos el router al paso 3 antes de invocar — el switch del slot
 * lo hace `switchToRunViewWithScheduler` directamente. Esto evita un commit
 * extra del router que dispararía un re-render inmediato.
 */
async function resumeInterruptedRun(
  root: HTMLElement,
  state: Extract<LoopRouterState, { status: "active" }>,
  details: InterruptedRunDetails,
  router: LoopRouter,
  commit: (next: MountedStep) => void,
): Promise<void> {
  // 1. Descartar outputs parciales.
  const discarded = await discardPartialOutputs(state.project.path, details.summary.runId).catch(
    (err) => {
      console.error("loop chrome: descartar outputs parciales falló", err);
      return [];
    },
  );
  if (discarded.length > 0) {
    console.info("loop resume: outputs parciales descartados", discarded);
  }

  // Sincronizar el router con el runId del run retomado. Si el router está
  // generando un runId nuevo (caso default), reemplazarlo con el del run
  // persistido. Lo hacemos con un truco: el router expone `abandonRun` para
  // regenerar; no expone setRunId. Navegamos al paso 4 (run en vivo) — el
  // chrome reusa ese slot para mostrar el timeline del scheduler retomado.
  // El runId del router no importa al timeline (usamos el de details).
  router.setStep(4);

  // 2 + 3 + 4: rewind stages running → pending, hidratar scheduler, mountar
  // vista run, arrancar ciclo.
  const rewinded = rewindRunningStages(details.state);

  const shell = root.querySelector(".loop-shell");
  if (!shell) throw new Error("loop chrome: shell no encontrado al retomar");

  const oldSlot = shell.querySelector("#loop-step-slot");
  const newSlot = renderStepSlot(3);
  if (oldSlot) oldSlot.replaceWith(newSlot);
  else shell.appendChild(newSlot);

  const scheduler = new RunScheduler();
  scheduler.hydrateFromPersisted(rewinded);

  const handle = mountStep3Run(newSlot, {
    scheduler,
    projectName: state.project.name,
  });

  const notifier = attachRunNotifier(scheduler);

  commit({
    runId: details.summary.runId,
    step: 4,
    handle,
    scheduler,
    notifier,
  });

  // Sacar el banner ahora que el run está retomado.
  const banner = shell.querySelector(".loop-resume-banner");
  if (banner) banner.remove();

  // Arrancar el ciclo. Como `rewindRunningStages` deja `status: "paused"`,
  // el `start()` lo va a sobrescribir a "running" y arrancar desde el primer
  // pending stage de la primera fase no-done.
  void scheduler.start();
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

function renderLoading(): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "loop-gate";
  const p = document.createElement("p");
  p.className = "loop-gate-msg loop-gate-muted";
  p.textContent = "cargando…";
  wrap.appendChild(p);
  return wrap;
}

function renderNoProjectGate(): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "loop-gate";
  const h = document.createElement("h2");
  h.className = "loop-gate-title";
  h.textContent = "Elegí un project primero";
  const p = document.createElement("p");
  p.className = "loop-gate-msg";
  p.textContent =
    "El /loop trabaja sobre el project activo del workspace. Abrí la ventana principal y seleccioná uno para empezar.";
  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "loop-btn loop-btn-primary";
  cta.textContent = "Abrir workspace";
  // Foco la ventana principal: el label "main" coincide con la ventana root
  // de Tauri por convención (la abierta por la app al iniciar). Si no
  // existe, no hay mucho más que podamos hacer desde acá.
  cta.addEventListener("click", () => {
    void focusMainWindow();
  });
  wrap.append(h, p, cta);
  return wrap;
}

async function focusMainWindow(): Promise<void> {
  try {
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const all = await getAllWebviewWindows();
    const main = all.find((w) => w.label === "main") ?? all.find((w) => w.label !== "loop");
    if (main) {
      await main.unminimize();
      await main.show();
      await main.setFocus();
    }
  } catch (err) {
    console.error("Could not focus main window from /loop gate", err);
  }
}

function renderInvalidPathGate(name: string, path: string): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "loop-gate loop-gate-error";
  const h = document.createElement("h2");
  h.className = "loop-gate-title";
  h.textContent = "Path inválido";
  const p = document.createElement("p");
  p.className = "loop-gate-msg";
  p.textContent = `El project "${name}" apunta a un path que no existe o no es accesible.`;
  const code = document.createElement("code");
  code.className = "loop-gate-path";
  code.textContent = path;
  const hint = document.createElement("p");
  hint.className = "loop-gate-msg loop-gate-muted";
  hint.textContent =
    "Volvé al workspace y corregí el path (clic derecho → cambiar path) antes de usar /loop.";
  wrap.append(h, p, code, hint);
  return wrap;
}

function renderHeader(
  router: LoopRouter,
  state: Extract<LoopRouterState, { status: "active" }>,
  prev: MountedStep | null,
): HTMLElement {
  const header = document.createElement("header");
  header.className = "loop-header";

  // Bloque izquierdo: project + run-id
  const left = document.createElement("div");
  left.className = "loop-header-left";

  const projectName = document.createElement("span");
  projectName.className = "loop-header-project";
  projectName.textContent = state.project.name;
  projectName.title = state.project.path;

  const sep1 = document.createElement("span");
  sep1.className = "loop-header-sep";
  sep1.textContent = "·";

  const runLabel = document.createElement("span");
  runLabel.className = "loop-header-run";
  // Short run-id (8 chars del UUID) en el chrome; el id completo queda
  // accesible vía `title` para copy-paste cuando se debuggea un run.
  runLabel.textContent = `run ${shortRunId(state.runId)}`;
  runLabel.title = state.runId;

  left.append(projectName, sep1, runLabel);

  // Bloque medio: step indicator (navegable). Cada pill es un botón que cambia
  // el step actual via router. Si hay un scheduler corriendo y el usuario salta
  // a otro step, pedimos confirmación porque la abortamos.
  const steps = document.createElement("nav");
  steps.className = "loop-header-steps";
  steps.setAttribute("aria-label", "pasos del run");
  const schedulerLive =
    prev?.scheduler != null &&
    (prev.scheduler.getState().status === "running" ||
      prev.scheduler.getState().status === "paused");
  // Pill 4 sólo está habilitada si hay un scheduler vivo (el usuario sólo
  // accede a step 4 vía "▶ ejecutar run" o un resume de run interrumpido).
  const hasScheduler = prev?.scheduler != null;
  for (const step of [1, 2, 3, 4] as const) {
    const isCurrent = step === state.step;
    const disabled = isCurrent || (step === 4 && !hasScheduler);
    steps.appendChild(
      renderStepPill(step, state.step, disabled, async () => {
        if (disabled) return;
        if (schedulerLive && state.step === 4 && step !== 4) {
          const ok = await confirmModal({
            title: "¿Salir del run en curso?",
            message:
              "Hay un scheduler ejecutando agentes. Si volvés a otro paso ahora, el agente en curso se aborta y la fase queda incompleta (el resume puede levantarla después).",
            confirmLabel: `ir al paso ${step}`,
            cancelLabel: "quedarme",
            danger: true,
          });
          if (!ok) return;
          prev?.scheduler?.abort();
        }
        router.setStep(step);
      }),
    );
  }

  // Bloque derecho: abandonar
  const right = document.createElement("div");
  right.className = "loop-header-right";
  const abandon = document.createElement("button");
  abandon.type = "button";
  abandon.className = "loop-btn loop-btn-ghost";
  abandon.textContent = "abandonar run";
  abandon.setAttribute("aria-label", "abandonar run actual");
  // Section 10.2 — confirmación modal antes de descartar progreso. El mensaje
  // adapta su tono según si hay un run en ejecución (scheduler vivo) o sólo
  // el chat del paso 1/2 sin guardar.
  const runIsLive =
    prev?.scheduler != null &&
    (prev.scheduler.getState().status === "running" ||
      prev.scheduler.getState().status === "paused");
  abandon.addEventListener("click", () => {
    void (async () => {
      const ok = await confirmModal({
        title: runIsLive ? "¿Abortar el run en curso?" : "¿Abandonar el run actual?",
        message: runIsLive
          ? "El scheduler está ejecutando agentes. Si abortás ahora, los outputs del agente en curso se descartan y la fase queda incompleta — el resume del paso 9 detecta este caso, pero igualmente se pierde el trabajo en vuelo."
          : "Se descarta el progreso del paso 1/2 que no haya sido guardado en disco (drafts, fases sin save, etc.).",
        confirmLabel: runIsLive ? "abortar run" : "abandonar",
        cancelLabel: "cancelar",
        danger: true,
      });
      if (!ok) return;
      // Si hay un run vivo, abortamos el scheduler explícitamente antes de
      // regenerar el runId — el dispose del MountedStep también lo hace, pero
      // queremos asegurarnos de que el scheduler libere el heartbeat y
      // persista el último state.json con status="aborted".
      if (prev?.scheduler) prev.scheduler.abort();
      router.abandonRun();
    })();
  });
  right.appendChild(abandon);

  header.append(left, steps, right);
  return header;
}

function renderStepPill(
  step: LoopStep,
  current: LoopStep,
  disabled: boolean,
  onClick: () => void | Promise<void>,
): HTMLElement {
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "loop-step-pill";
  if (step === current) pill.classList.add("loop-step-pill-current");
  if (step < current) pill.classList.add("loop-step-pill-done");
  pill.textContent = `${step}`;
  pill.setAttribute("aria-current", step === current ? "step" : "false");
  pill.setAttribute("aria-label", `${stepLabel(step)}${step === current ? " (actual)" : ""}`);
  pill.title = stepLabel(step);
  pill.disabled = disabled;
  pill.addEventListener("click", () => {
    void onClick();
  });
  return pill;
}

function stepLabel(step: LoopStep): string {
  switch (step) {
    case 1:
      return "Paso 1 · problem intake";
    case 2:
      return "Paso 2 · descomposición de fases";
    case 3:
      return "Paso 3 · setup del run";
    case 4:
      return "Paso 4 · ejecución";
  }
}

function renderStepSlot(step: LoopStep): HTMLElement {
  const slot = document.createElement("section");
  slot.className = "loop-step-slot";
  slot.id = "loop-step-slot";
  slot.dataset.step = `${step}`;
  // Slot vacío; los pasos 1–4 montan su contenido encima reemplazando los
  // children. Si por alguna razón nadie monta nada (estado inconsistente),
  // el slot queda vacío sin texto de debug confuso.
  return slot;
}

function shortRunId(id: string): string {
  // UUID v4: `xxxxxxxx-xxxx-...` — los primeros 8 chars dan colisión
  // virtualmente nula para los runs simultáneos que el usuario va a manejar.
  return id.split("-")[0] ?? id.slice(0, 8);
}
