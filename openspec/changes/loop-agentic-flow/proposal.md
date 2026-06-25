## Why

El módulo `/loop` hoy es una ventana Tauri vacía. Queremos convertirlo en un proceso agéntico de 3 pasos (entender → descomponer → ejecutar) que automatice tareas de ingeniería complejas usando múltiples CLIs LLM (claude, codex, opencode) — orquestando agentes especializados (análisis, implementación, revisor, conocimiento, integrador) con dos modos de ejecución (secuencial y híbrido por batches).

El diseño está cerrado (ver `docs/loop-agentic-design.html`) con 15 decisiones tomadas y el spike de invocación CLI ya validado.

## What Changes

- **Nueva ventana `/loop`** con UI de 3 pasos: chat de refinamiento del problema, editor de fases con dependencias, setup + ejecución del run.
- **Multi-CLI orchestration**: cada agente del Paso 3 corre en un CLI/modelo elegible (claude/codex/opencode), invocado en modo one-shot (`-p` / `exec` / `run`) desde un comando Tauri nuevo.
- **Sistema de fases con `dependsOn`**: el LLM del Paso 2 propone dependencias entre fases; el sistema computa batches por sort topológico para el modo híbrido.
- **Loop con revisor con cap de 3 reintentos**: si no aprueba, la fase queda en estado ⚠ y el knowledge anota la deuda; el run sigue.
- **Modo híbrido con integrador por batch**: corre fases independientes en paralelo y consolida knowledge entre batches.
- **Perfiles globales**: matriz `agente × CLI × modelo` editable, persistida en `profiles.json` vía `tauri-plugin-store`.
- **Prompts globales editables**: 7 prompts (2 pre-fases + 5 agentes) en config dir de la app, copiados al árbol del run al iniciar.
- **Persistencia y resume**: cada run guarda `state.json` con granularidad por agente; al detectar un run interrumpido se puede retomar desde la última tarea incompleta.
- **Scoping al project activo**: el `/loop` requiere un project activo del workspace; hereda `cwd`, CLI sugerido y validación de path.
- Reutiliza `import_user_path()` existente (`src-tauri/src/lib.rs:17`) que ya garantiza que claude/codex/opencode estén en el PATH del subproceso.

## Capabilities

### New Capabilities

- `loop-problem-intake`: Paso 1 — chat multi-turno con un CLI para refinar el problema del usuario hasta producir `01-problem.md`. Cada turno serializa la conversación previa en el prompt (one-shot, sin sesión persistente).
- `loop-phase-decomposition`: Paso 2 — genera la lista de fases del run con `logic.md` (siempre) + `visual.html` (opcional, decisión del LLM) + `dependsOn[]`. UI con sidebar de fases, editor inline, "editar con AI", y vista de topología derivada del DAG.
- `loop-execution-engine`: Paso 3 — scheduler con modo secuencial y modo híbrido (batches por sort topológico, integrador entre cada batch). Orquesta los 5 agentes (análisis → implementación → revisor con cap 3 → conocimiento; integrador entre batches en modo híbrido). Estado persistido en `state.json` con resume tras crash.
- `loop-profiles`: configuración global de la matriz `agente × CLI × modelo`. JSON via `tauri-plugin-store` (`profiles.json`). Default sin perfil cargado = todo `claude/opus-4-7`. Overrides son temporales por run (botones explícitos para guardar como nuevo perfil o pisar el cargado). Validación al cargar: slot rojo si CLI/modelo no existe.
- `loop-prompt-defaults`: gestión de los 7 prompts default (2 pre-fases + 5 agentes). Globales editables en config dir (`prompts/*.md`). Al crear un run, copia atómica de globales al árbol del run. Editables inline en el setup del Paso 3 con botones `↑ resetear a global` y `↓ guardar como default global` por prompt.

### Modified Capabilities

Ninguna. No hay specs previos en `openspec/specs/`.

## Impact

**Frontend (TypeScript)**:
- `src/modules/loop/` — actualmente placeholder; absorbe toda la UI nueva (3 pasos, editor de fases, topología, setup con sidebar+editor, vista de ejecución por modo).
- `src/shared/persistence/` — nuevos stores para `profiles.json` y los `prompts/` globales (mismo patrón que `workspaces-store.ts:1`).
- `src/modules/workspaces/` — gate de "no se abre `/loop` sin project activo" + barra de "viendo project X · run activo en project Y".

**Backend (Rust / Tauri)**:
- `src-tauri/src/loop_cli.rs` (nuevo) — comando Tauri `run_loop_agent` que invoca el CLI configurado, normaliza output (claude JSON / codex `--output-last-message` / opencode stream) a un `AgentResult` común, con `tokio::time::timeout`.
- `src-tauri/src/lib.rs` — registrar el nuevo comando en el invoke handler (línea ~74).
- `src-tauri/capabilities/loop.json` — permisos del comando para la ventana `/loop`.
- `src-tauri/Cargo.toml` — sumar `tokio` con feature `time` si no está; `serde_json` ya está disponible vía `serde`.

**Filesystem**:
- Config dir de la app: `profiles.json`, `prompts/*.md` (7 archivos).
- Cada project con runs: `<project>/.loop/runs/<run-id>/` con `01-problem.md`, `phases/`, `prompts/` (copia), `state.json`, `outputs/`, `outputs/batches/`.

**No afecta**:
- Workspaces, terminales, panel de notas, módulos existentes — el `/loop` es aditivo.
- Schema de `workspaces.json` — el path del project se sigue leyendo como hoy.

**Dependencias externas**: ninguna nueva en runtime. Los CLIs (`claude`, `codex`, `opencode`) son requisitos del usuario, no del app. El bootstrap de PATH ya está hecho.
