## 1. Backend Tauri — comando `run_loop_agent`

- [x] 1.1 Crear `src-tauri/src/loop_cli.rs` con el struct `AgentResult { text, tokens_in, tokens_out, cost_usd, session_id, error }`
- [x] 1.2 Implementar `#[tauri::command] async fn run_loop_agent(cli, model, cwd, system_prompt_path, user_input, timeout_secs)` con `tokio::time::timeout` wrappeando `std::process::Command::output()`
- [x] 1.3 Parsear output de claude (`--output-format json`) → `AgentResult`
- [x] 1.4 Parsear output de codex (`--output-last-message <file>` + `--json` para tokens) → `AgentResult`
- [x] 1.5 Parsear output de opencode (`--format json` stream) → `AgentResult` extrayendo el último mensaje del agente
- [x] 1.6 Manejo de errores: CLI no encontrado, timeout, exit code ≠ 0, JSON malformado
- [x] 1.7 Registrar el comando en `src-tauri/src/lib.rs` (invoke_handler ~línea 74)
- [x] 1.8 Agregar permiso del comando en `src-tauri/capabilities/loop.json`
- [x] 1.9 Verificar que `tokio` con feature `time` esté en `Cargo.toml`
- [ ] 1.10 Smoke test manual: invocar con claude/haiku desde la consola devtools, confirmar `AgentResult` parseado

## 2. Persistencia — profiles y prompts globales

- [x] 2.1 Crear `src/shared/persistence/loop-profiles-store.ts` siguiendo el patrón de `workspaces-store.ts` (load + queueSave con debounce + schemaVersion)
- [x] 2.2 Definir tipos `LoopProfile`, `LoopProfilesState`, `AgentSlot { cli, model }` en `src/modules/loop/state/types.ts`
- [x] 2.3 Bundle los 7 prompts default como strings (`include_str!` en Rust o resources de Vite) — decidir según convenga
- [x] 2.4 Implementar comando Tauri `loop_ensure_prompts_dir` que verifica/crea `<app-config>/prompts/` y restaura archivos faltantes desde los bundled
- [x] 2.5 Implementar `loop_read_global_prompt(name)` / `loop_write_global_prompt(name, content)` para los 7 archivos
- [x] 2.6 Implementar `loop_create_run(projectPath, runId)` que crea `<project>/.loop/runs/<runId>/` con la subcarpeta `prompts/` copiada atómicamente desde los globales
- [x] 2.7 Implementar `loop_validate_cli_model(cli, model)` que devuelve `{ ok, reason }` chequeando PATH y un ping al modelo
- [x] 2.8 Tests unitarios del store (`workspaces-controller.test.ts` como referencia para la forma)

## 3. Ventana /loop — chrome y gate

- [x] 3.1 Actualizar `src/modules/loop/loop.ts` para montar el router de 3 pasos
- [x] 3.2 Gate de project activo: si `activeProjectId` es null, mostrar "elegí un project primero" y CTA al workspace
- [x] 3.3 Gate de path inválido: si `pathInvalid`, mostrar el error de path
- [x] 3.4 Header persistente con: nombre del project, run-id, paso actual (1/2/3), botón "abandonar run"
- [x] 3.5 Estilos base en `src/modules/loop/loop.css` reutilizando tokens del app principal

## 4. Paso 1 — Chat de problem intake

- [x] 4.1 Componente de chat con input grande, lista de turnos, selector de CLI (claude/codex/opencode)
- [x] 4.2 Lógica de serialización de historia: cada turno arma un prompt con todos los turnos previos antes de invocar `run_loop_agent`
- [x] 4.3 Persistir la conversación en `<run>/01-problem-draft.md` después de cada turno (para resume)
- [x] 4.4 Botón "✎ editar prompt de sistema" que abre el editor sobre `<run>/prompts/problem-intake.md`
- [x] 4.5 Botón "✓ consolidar problema.md →" que invoca un último turno pidiendo un resumen estructurado y lo escribe en `<run>/01-problem.md`
- [x] 4.6 Validar que haya al menos 1 turno antes de habilitar "consolidar"
- [x] 4.7 Navegación al Paso 2 al consolidar

## 5. Paso 2 — Descomposición en fases

- [x] 5.1 Comando Tauri / módulo TS que invoca `phase-decomposition.md` con `01-problem.md` y parsea la respuesta a una lista de `Phase { id, name, dependsOn[], hasVisual }`
- [x] 5.2 Crear las carpetas `<run>/phases/<NN>-<slug>/` con `logic.md` (siempre) y `visual.html` (cuando `hasVisual`)
- [x] 5.3 Sidebar de fases con: numero, nombre, badges `md`/`html`, línea de dependencias debajo
- [x] 5.4 Tabs `logic.md` / `visual.html` en el panel principal; ocultar tab `visual.html` si la fase no tiene
- [x] 5.5 Editor de texto inline (Monaco o textarea estilizada — decidir según footprint)
- [x] 5.6 Toolbar con "guardar", "✨ editar con AI" (selección + instrucción → diff)
- [x] 5.7 Editor de `dependsOn`: multi-select con las otras fases; detección de ciclos al guardar
- [x] 5.8 Botón "+ agregar fase" + delete fase con confirmación si tiene dependientes
- [x] 5.9 Vista "topología de ejecución" read-only: sort topológico → render por batches en lanes
- [x] 5.10 Botón "→ Paso 3" disponible cuando todas las fases tienen al menos `logic.md`

## 6. Paso 3 — Setup unificado

- [x] 6.1 Barra superior con project activo + CLI sugerido del project
- [x] 6.2 Selector de modo (secuencial / híbrido) con detección automática "modo paralelo equivalente a secuencial" si todo es lineal
- [x] 6.3 Dropdown de perfil cargado + botón "guardar como…" / "guardar"
- [x] 6.4 Sidebar con los 7 prompts (2 pre-fases + 5 agentes), cada uno mostrando CLI/modelo actual + badge default/modificado
- [x] 6.5 Panel principal con: nombre del agente, descripción inputs/outputs, dropdowns CLI/modelo, botones "↑ resetear a global" y "↓ guardar como default global", textarea del prompt
- [x] 6.6 Detección en vivo de `default` vs `modificado` comparando con el global actual
- [x] 6.7 Validación de cada slot al cargar perfil (CLI en PATH + modelo válido) con marcado rojo
- [x] 6.8 Config row: max retries (default 3 read-only por ahora), budget de tokens, comportamiento al fallo (read-only "propagar warning")
- [x] 6.9 Botón "▶ ejecutar run" deshabilitado si hay slots en rojo

## 7. Paso 3 — Engine secuencial

- [x] 7.1 Crear `src/modules/loop/state/run-scheduler.ts` con el state machine del scheduler
- [x] 7.2 Implementar el pipeline por fase: análisis → impl → revisor (≤ 3 tries) → conocimiento
- [x] 7.3 Cada paso invoca `run_loop_agent` con el CLI/modelo configurado y persiste el output en `<run>/outputs/<phase>/<agent>.md`
- [x] 7.4 Snapshot de diff por agente: `git stash` antes/después → `<run>/outputs/<phase>/<agent>.diff`
- [x] 7.5 Logic del cap: al 3er reintento sin aprobación, marcar fase `warning`, anotar deuda en el input del agente de conocimiento, seguir
- [x] 7.6 Persistir `state.json` después de cada agente con `lastHeartbeat`
- [x] 7.7 Vista en ejecución (modo secuencial): timeline vertical de fases con 4 columnas de agentes; estados pending/running/done/warning
- [x] 7.8 Budget en vivo (tokens + USD acumulado, desglose por agente)
- [x] 7.9 Botón "pausar run" y "abortar run"

## 8. Paso 3 — Engine híbrido con batches

- [x] 8.1 Algoritmo de sort topológico sobre `phases[].dependsOn` → `batches: Phase[][]`
- [x] 8.2 Ejecutar fases del batch en paralelo (`Promise.all` sobre pipelines individuales)
- [x] 8.3 Implementar agente integrador: input = todos los outputs del batch + diffs; output = `knowledge.md` consolidado en `<run>/outputs/batches/batch-<N>/knowledge.md`
- [x] 8.4 Detección de conflictos de FS por el integrador (`git diff --check` o equivalente sobre los stash de impl)
- [x] 8.5 Al conflict: pausar el run y mostrar reporte (continuar / abortar / re-ejecutar)
- [x] 8.6 Pasar el knowledge consolidado del batch N como input adicional a las fases del batch N+1
- [x] 8.7 Vista en ejecución (modo híbrido): batches separados visualmente, mini-cards por fase con barras de progreso por etapa, banner de warning si alguna fase llegó al cap
- [x] 8.8 Integrador en vivo: card propia entre batches mostrando "esperando" / "corriendo" / "✓"

## 9. Persistencia y resume

- [x] 9.1 Definir el schema completo de `state.json` con tipos TS + validador
- [x] 9.2 Escritura de `state.json` después de cada cambio de estado significativo
- [x] 9.3 Heartbeat: timer que actualiza `lastHeartbeat` cada N segundos durante invocaciones de agente
- [x] 9.4 Al abrir `/loop` sobre un project, escanear `<project>/.loop/runs/` por runs con `status: "running"` y heartbeat viejo (> N×3 segundos)
- [x] 9.5 Banner "run interrumpido detectado · ¿retomar?" con botones retomar / archivar
- [x] 9.6 Al retomar: descartar outputs parciales (archivo sin `<agent>.diff` final), relanzar desde el último agente incompleto
- [ ] 9.7 Test manual: matar el proceso a mitad de un run, reabrir, confirmar que retoma sin perder fases completas

## 10. Polish y casos borde

- [x] 10.1 Toast/notificaciones para eventos clave: run completado, fase con warning, budget excedido, conflicto detectado
- [x] 10.2 Confirmación al abandonar un run a la mitad (riesgo de perder estado no guardado)
- [x] 10.3 Atajos de teclado: Cmd+Enter para enviar mensaje en Paso 1, Cmd+S en editores
- [x] 10.4 Empty states: sin perfiles, sin runs previos, run abandonado
- [x] 10.5 Logs de invocaciones de CLI a archivo (debugging futuro) — opcional pero útil
- [x] 10.6 Revisar accesibilidad básica de los focus rings y aria-labels nuevos
- [x] 10.7 Documentar en `README.md` que `claude`, `codex`, `opencode` deben estar instalados para usar `/loop`

## 11. Validación final

- [ ] 11.1 Run de smoke end-to-end: project chico, 3 fases, modo secuencial, claude para todo
- [ ] 11.2 Run multi-CLI: análisis claude, impl opencode, revisor codex — confirma que el contrato vía archivos funciona
- [ ] 11.3 Run híbrido con 5 fases en 2 batches, confirmar que el integrador detecta el batch correcto y propaga knowledge
- [ ] 11.4 Test de cap del revisor: forzar un caso donde el revisor pide retry 3 veces seguidas, verificar warning propagado
- [ ] 11.5 Test de resume: matar app a mitad, reabrir, retomar
- [ ] 11.6 Test de validación de perfil: configurar slot con CLI desinstalado, ver marcado rojo, ver run deshabilitado
- [ ] 11.7 Test de promoción de prompt a global: editar inline, "guardar como default global", verificar archivo en `<app-config>/prompts/`
