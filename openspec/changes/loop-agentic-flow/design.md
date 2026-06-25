## Context

El módulo `/loop` hoy es una ventana Tauri vacía (`loop.html` + `src/modules/loop/loop.ts` placeholder, abierta desde `src/modules/agents-flow/loop-window.ts`). Esta propuesta lo convierte en un sistema agéntico de 3 pasos que orquesta múltiples CLIs LLM (claude, codex, opencode) en modo one-shot.

El diseño completo y los mockups visuales están en `docs/loop-agentic-design.html` (15 decisiones cerradas, spike de CLI validado). Este documento extracta las decisiones técnicas y trade-offs.

**Contexto del repo relevante**:
- El app es Tauri 2 + Vite + TypeScript. State management custom (no React/Vue) — ver `src/modules/workspaces/state/` para el patrón establecido (reducer + controller + types).
- Persistencia local: `tauri-plugin-store` con archivos JSON (ver `src/shared/persistence/workspaces-store.ts:1`).
- Subprocesos: `std::process::Command::output()` (one-shot) y `portable_pty` (streaming) — ambos patrones ya en `src-tauri/src/`.
- Bootstrap de PATH para macOS ya resuelto en `src-tauri/src/lib.rs:17` (menciona claude/codex/opencode por nombre).
- El project activo del workspace expone `path`, `activeCliId`, y validación de path — todo heredable por `/loop`.

## Goals / Non-Goals

**Goals:**
- Permitir al usuario refinar un problema con LLM, descomponerlo en fases con dependencias, y ejecutarlo con agentes especializados.
- Soportar dos modos de ejecución (secuencial / híbrido por batches) eligibles antes del run.
- Multi-CLI por agente: cada uno de los 5 agentes del Paso 3 puede usar un CLI/modelo distinto.
- Reanudación tras crash con granularidad por agente.
- Cero acoplamiento entre CLIs: contrato vía archivos en disco (no por sesiones LLM heredadas).
- Reutilizar lo que ya existe en el repo (PATH bootstrap, plugin-store, patrón Command).

**Non-Goals:**
- Streaming token-a-token en los agentes del Paso 3 (one-shot es suficiente; sólo el chat del Paso 1 podría beneficiarse).
- Compartir perfiles entre máquinas (son globales locales, no se commitean).
- Sandbox de FS por agente (decisión: todos los agentes pueden escribir; mitigación vía registro de diff post-hoc).
- Edición de prompts via UI separada de Settings (vive inline en el setup del Paso 3).
- Override de profiles por project (sólo globales en esta iteración).
- Worktrees git por fase (descartado al elegir "modo paralelo solo para fases independientes").

## Decisions

### 1. Contrato entre agentes vía archivos en disco
**Decisión**: cada agente lee archivos del run (`logic.md`, `visual.html`, `analysis.md`, etc.) y escribe **su** archivo. No hay conversaciones LLM heredadas entre agentes.

**Alternativa considerada**: pasar el stream de mensajes del CLI anterior al siguiente. Rechazada porque acopla formatos heterogéneos (claude JSON, codex JSONL, opencode events) y bloquea la mezcla de CLIs.

**Implicancia**: facilita el resume — basta inspeccionar qué archivos existen y cuáles no.

### 2. Modo paralelo "híbrido" con sort topológico
**Decisión**: el modo paralelo no es "todo al mismo tiempo"; usa `dependsOn[]` declarado en cada fase para computar batches. Sort topológico estándar: batch 1 = fases sin dependencias, batch N+1 = fases cuyas dependencias están todas en batches ≤ N.

**Alternativa considerada**: paralelo "puro" con worktrees git por fase. Rechazada por la complejidad operacional (merges, conflictos, cleanup) y porque trasladaba el problema a un integrador final ciego.

**Implicancia**: el integrador corre **por batch**, no sólo al final. Permite detectar conflictos temprano y propagar knowledge entre batches.

### 3. One-shot CLI con history serializada en multi-turno
**Decisión**: todas las invocaciones de CLI son one-shot (`claude -p`, `codex exec`, `opencode run`). En el Paso 1 (multi-turno), cada turno serializa la conversación previa en el prompt.

**Alternativa considerada**: sesiones persistentes con `--resume` flags. Rechazada porque (a) introduce estado en el CLI que la app no controla, (b) cada CLI tiene su propio formato de session id, (c) el spike confirmó que one-shot es suficiente y predecible.

**Implicancia**: el costo por turno crece linealmente con la historia (cache de prompt del CLI puede mitigarlo). Aceptable para conversaciones cortas de refinamiento.

### 4. Cap del revisor en 3 con propagación de warning
**Decisión**: el revisor tiene exactamente 3 intentos. Al cuarto se descarta — la fase queda con estado `warning` (⚠) y el knowledge agent corre igual con el último output. La deuda se anota en `knowledge.md` para que la(s) fase(s) dependiente(s) lo vean.

**Alternativa considerada**: preguntar al usuario al alcanzar el cap. Rechazada porque rompe el flow automático y agrega fricción a runs largos.

**Implicancia**: el resumen final del run muestra qué fases quedaron sin aprobar. El usuario puede re-correr esas fases manualmente.

### 5. Almacenamiento JSON, no SQLite, para profiles y prompts
**Decisión**: ambos viven en el config dir de la app vía `tauri-plugin-store` (`profiles.json`) o archivos sueltos (`prompts/*.md`).

**Alternativa considerada**: SQLite con `rusqlite`. Rechazada porque (a) 1-20 perfiles no justifican un motor relacional, (b) introduce dependencia nueva (+1MB binario), (c) rompe consistencia con `workspaces.json`, (d) los runs históricos no se indexan globalmente — viven como archivos en `<project>/.loop/runs/`.

**Implicancia**: si en algún futuro se necesita indexar runs cross-project con queries, SQLite puede agregarse para eso sin tocar profiles/prompts.

### 6. Permisos de FS sin restricción + auditoría
**Decisión**: todos los agentes pueden escribir cualquier archivo. No hay sandboxing por agente.

**Alternativa considerada**: diff post-hoc descartando cambios fuera del `.md` esperado. Rechazada por la complejidad (qué cuenta como "esperado" varía por contexto) y por dejar la decisión al usuario.

**Mitigación**: cada agente se invoca con un `git stash` previo y posterior para snapshotear su diff. Se guarda en `<run>/outputs/<phase>/<agent>.diff` (o equivalente) para auditoría.

### 7. Estado persistente con granularidad por agente
**Decisión**: `state.json` por run con campos: `currentBatch`, `phases[id]: { status, lastAgent, retryAttempt, warning }`, `integrators[batchId]: status`, `lastHeartbeat`. El resume detecta tareas incompletas y relanza el agente que estaba en curso (descartando outputs parciales).

**Alternativa considerada**: log estructurado (event-sourcing) reconstruido al abrir. Más robusto pero overkill — un snapshot bien definido cubre el caso.

### 8. Validación de perfil al cargar sin auto-fallback
**Decisión**: si un CLI no está instalado o un modelo no existe, el slot se marca en rojo y el run no puede ejecutarse hasta que el usuario corrija. Sin sugerencias automáticas.

**Alternativa considerada**: fallback automático a "claude/opus-4-7" si el slot rompe. Rechazada porque cambia el comportamiento esperado del run silenciosamente.

### 9. Prompts globales con copia atómica al run
**Decisión**: los 7 prompts viven en `<app-config>/prompts/`. Al crear un run, se copian atómicamente a `<run>/prompts/`. Ediciones en el run no se propagan; ediciones en globales no afectan runs ya creados.

**Alternativa considerada**: referencia por path (run apunta al global). Rechazada porque rompe la inmutabilidad del run y dificulta el resume reproducible.

### 10. UI inline en el setup del Paso 3 (no settings separado)
**Decisión**: la edición de prompts vive en una vista unificada del setup del Paso 3 — sidebar de los 7 prompts + editor principal con dropdowns de CLI/modelo. Sin pantalla de Settings dedicada.

**Alternativa considerada**: pantalla de Settings global. Rechazada por preferencia del usuario (decisión 15 del design doc): mantener todo el ciclo de vida del run visible en una sola superficie.

## Risks / Trade-offs

| Riesgo | Mitigación |
|--------|-----------|
| Aliases de modelo cambian entre versiones (ej. `haiku-4-5` 404 vs `haiku` OK) | Validación al cargar perfil marca slot en rojo. Documentar matriz `cli × modelo` soportada con versión testeada. |
| Costo de tokens descontrolado con multi-CLI (cada agente factura aparte) | Budget visible en vivo desglosado por agente. Pausa automática al exceder. |
| Loop revisor que oscila sin converger | Cap hard de 3 intentos. Más allá, fase queda con warning y el flow sigue. |
| Modo paralelo + conflictos de FS no detectados por dependencias incorrectas | El integrador del batch hace `git diff --check` antes de aprobar el batch. Conflicto pausa el run. |
| Agentes con permisos totales corrompen el FS sin control | `git stash` por agente para preservar el snapshot, diff exportable. El usuario revisa post-mortem. |
| Aplicación cierra a mitad de un run sin guardar estado | Heartbeat cada N segundos en `state.json` + resume detect en próxima apertura del project. |
| El LLM del Paso 2 declara mal las dependencias (fases que se pisan en realidad) | Usuario revisa la vista topología antes de ejecutar. El integrador del batch detecta conflictos reales. |
| Subproceso colgado (CLI no responde) | `tokio::time::timeout` con default 300s. Al timeout, kill del subproceso y reporte como fallo. |
| `--dangerously-skip-permissions` en claude / `--sandbox` en codex requieren configuración | Documentar la matriz: el agente de implementación corre sin restricción; análisis/revisor/conocimiento con `--print` (read-only de facto). |
| Bundling de los 7 prompts default en el binario | Embeber con `include_str!` en Rust o resources de Tauri. Decisión deferred a implementación. |

## Migration Plan

No hay migración de datos — el `/loop` es aditivo. Los archivos nuevos viven en lugares nuevos:
- Config dir: `profiles.json`, `prompts/*.md` (creados on-demand al primer arranque post-update)
- Por project: `<project>/.loop/runs/<run-id>/...` (creado al iniciar el primer run)

**Rollback**: el usuario puede borrar `<app-config>/profiles.json`, `<app-config>/prompts/`, y `<project>/.loop/` sin afectar el resto de la app. El módulo `/loop` puede coexistir o desaparecer sin tocar workspaces, terminales, ni notas.

**Orden de implementación sugerido** (también reflejado en `tasks.md`):
1. Backend del comando Tauri `run_loop_agent` + tests con smoke calls.
2. Store de profiles + prompts globales (defaults bundled, copia atómica al run).
3. UI del Paso 1 (más simple, valida el patrón one-shot + serialización de historia).
4. UI del Paso 2 (más compleja: editor + topología + edición con AI).
5. Engine secuencial del Paso 3 (sin batches, sin integrador).
6. Engine híbrido con batches + integrador.
7. Persistencia + resume.

Cada paso es un PR coherente, vendible solo. Si algo bloquea más adelante (ej. resume), los pasos previos siguen siendo útiles.

## Open Questions

Ninguna que bloquee la implementación. Las cosas a decidir durante el código (no por el diseño) son:

- **Cómo bundlear los 7 prompts default**: `include_str!` en Rust vs resources de Tauri vs archivos copiados por Vite a `dist/`. La decisión se toma al armar el commit del seed inicial.
- **Default exacto del timeout por agente**: 300s parece razonable, pero podría ajustarse según el modelo (opus tarda más que haiku). Configurable global + override per-run en V2.
- **Frecuencia del heartbeat para detectar crash**: 5s por defecto, recalibrar si hace ruido en la UI.
- **Tamaño del knowledge.md**: queda como hard limit ~2k tokens (vía prompt). Si en runs grandes esto sufre, agregar compresión secundaria.
