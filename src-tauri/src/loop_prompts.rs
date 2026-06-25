//! Gestión de los 7 prompts globales y de los runs de `/loop`.
//!
//! Comandos Tauri expuestos:
//! - `loop_ensure_prompts_dir`: crea `<app-config>/prompts/` y restaura archivos
//!   faltantes desde los bundled (`include_str!`).
//! - `loop_read_global_prompt(name)` / `loop_write_global_prompt(name, content)`:
//!   read/write de los 7 archivos editables.
//! - `loop_create_run(projectPath, runId)`: crea el árbol `<project>/.loop/runs/<runId>/`
//!   con la subcarpeta `prompts/` copiada atómicamente desde los globales.
//! - `loop_validate_cli_model(cli, model)`: chequea que el binario del CLI esté
//!   en PATH y hace un ping al modelo. Devuelve `{ ok, reason }`.
//!
//! Decisión: bundling vía `include_str!`. Es el patrón más simple y sin
//! dependencias nuevas; el binario crece ~10KB (los 7 .md sumados), nada
//! comparado con el overhead de meterlos como resources de Tauri y leerlos en
//! tiempo de ejecución. Ver design.md (sección "Open Questions", entrada
//! "Cómo bundlear los 7 prompts default").

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Los 7 nombres canónicos de los prompts. Cualquier otro nombre es rechazado
/// por `loop_read_global_prompt` / `loop_write_global_prompt`. Mantenemos esta
/// constante como única fuente de verdad para que un typo en TS no derive en
/// archivos huérfanos.
pub const PROMPT_NAMES: [&str; 7] = [
    "problem-intake.md",
    "phase-decomposition.md",
    "analysis.md",
    "implementation.md",
    "review.md",
    "knowledge.md",
    "integration.md",
];

/// Contenido bundled de cada prompt. Embebidos con `include_str!` desde
/// `src-tauri/prompts/` en build-time — si alguno de esos archivos no existe
/// el build falla.
fn bundled_content(name: &str) -> Option<&'static str> {
    match name {
        "problem-intake.md" => Some(include_str!("../prompts/problem-intake.md")),
        "phase-decomposition.md" => Some(include_str!("../prompts/phase-decomposition.md")),
        "analysis.md" => Some(include_str!("../prompts/analysis.md")),
        "implementation.md" => Some(include_str!("../prompts/implementation.md")),
        "review.md" => Some(include_str!("../prompts/review.md")),
        "knowledge.md" => Some(include_str!("../prompts/knowledge.md")),
        "integration.md" => Some(include_str!("../prompts/integration.md")),
        _ => None,
    }
}

fn is_known_prompt(name: &str) -> bool {
    PROMPT_NAMES.iter().any(|p| *p == name)
}

/// Devuelve `<app-config>/prompts/` resolviendo el config dir del app handle.
fn prompts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no pude resolver app_config_dir: {e}"))?;
    Ok(base.join("prompts"))
}

/// Crea (si no existe) `<app-config>/prompts/` y restaura cada archivo faltante
/// desde el bundled. No sobrescribe archivos existentes — sólo crea los que
/// faltan.
///
/// Devuelve la lista de nombres restaurados para que el frontend pueda
/// notificar al usuario qué archivos volvió a poblar.
#[tauri::command]
pub async fn loop_ensure_prompts_dir(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = prompts_dir(&app)?;
    tokio::task::spawn_blocking(move || ensure_dir_sync(&dir))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn ensure_dir_sync(dir: &Path) -> Result<Vec<String>, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("no pude crear {dir:?}: {e}"))?;

    let mut restored = Vec::new();
    for name in PROMPT_NAMES.iter() {
        let target = dir.join(name);
        if target.exists() {
            continue;
        }
        let seed = bundled_content(name)
            .ok_or_else(|| format!("seed bundled faltante para {name}"))?;
        write_atomic(&target, seed)?;
        restored.push((*name).to_string());
    }
    Ok(restored)
}

/// Lee el contenido del prompt global indicado. Si el archivo no existe, lo
/// restaura desde el bundled antes de leerlo (mismo invariante que
/// `loop_ensure_prompts_dir`, pero scoped a un solo archivo para evitar pasos
/// extra en read paths).
#[tauri::command]
pub async fn loop_read_global_prompt(
    app: tauri::AppHandle,
    name: String,
) -> Result<String, String> {
    if !is_known_prompt(&name) {
        return Err(format!("prompt desconocido: {name}"));
    }
    let dir = prompts_dir(&app)?;
    let name_clone = name.clone();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("no pude crear {dir:?}: {e}"))?;
        let target = dir.join(&name_clone);
        if !target.exists() {
            let seed = bundled_content(&name_clone)
                .ok_or_else(|| format!("seed bundled faltante para {name_clone}"))?;
            write_atomic(&target, seed)?;
        }
        std::fs::read_to_string(&target).map_err(|e| format!("no pude leer {target:?}: {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Pisa la copia del run de un prompt con el contenido actual del global. Útil
/// cuando el global se actualizó después de crear el run (los runs ya creados
/// tienen una copia atómica del momento de creación; este comando los sincroniza
/// explícitamente cuando el usuario lo pide).
#[tauri::command]
pub async fn loop_reset_run_prompt_to_global(
    app: tauri::AppHandle,
    project_path: String,
    run_id: String,
    name: String,
) -> Result<(), String> {
    if !is_known_prompt(&name) {
        return Err(format!("prompt desconocido: {name}"));
    }
    if !is_safe_run_id(&run_id) {
        return Err(format!("run_id inválido: {run_id}"));
    }
    let global_dir = prompts_dir(&app)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        // Aseguramos que exista el global; si no, lo restauramos desde bundled.
        std::fs::create_dir_all(&global_dir)
            .map_err(|e| format!("no pude crear {global_dir:?}: {e}"))?;
        let global_target = global_dir.join(&name);
        if !global_target.exists() {
            let seed = bundled_content(&name)
                .ok_or_else(|| format!("seed bundled faltante para {name}"))?;
            write_atomic(&global_target, seed)?;
        }
        let content = std::fs::read_to_string(&global_target)
            .map_err(|e| format!("no pude leer {global_target:?}: {e}"))?;

        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Err(format!("project no encontrado: {project:?}"));
        }
        let run_prompts_dir = project.join(".loop").join("runs").join(&run_id).join("prompts");
        if !run_prompts_dir.is_dir() {
            return Err(format!(
                "run dir no inicializado: {run_prompts_dir:?} (corré loop_create_run primero)"
            ));
        }
        let target = run_prompts_dir.join(&name);
        write_atomic(&target, &content)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Escribe el contenido del prompt global indicado. El nombre debe pertenecer
/// al set canónico — cualquier otro valor devuelve error sin tocar nada.
#[tauri::command]
pub async fn loop_write_global_prompt(
    app: tauri::AppHandle,
    name: String,
    content: String,
) -> Result<(), String> {
    if !is_known_prompt(&name) {
        return Err(format!("prompt desconocido: {name}"));
    }
    let dir = prompts_dir(&app)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("no pude crear {dir:?}: {e}"))?;
        let target = dir.join(&name);
        write_atomic(&target, &content)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Output de `loop_create_run`: paths absolutos de los directorios creados, por
/// si el frontend quiere mostrarlos o abrirlos.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRunPaths {
    pub run_dir: String,
    pub prompts_dir: String,
}

/// Crea el árbol del run sobre `<projectPath>/.loop/runs/<runId>/` y copia los
/// 7 prompts globales adentro de forma atómica (cada archivo se escribe a un
/// temp dentro del mismo dir y se hace `rename`).
///
/// El `runId` se sanea: sólo se permiten `[A-Za-z0-9_-]`. Cualquier otro char
/// se rechaza para no permitir traversal (`..`) ni separadores. El frontend
/// debería generar IDs con `crypto.randomUUID()` o similar.
#[tauri::command]
pub async fn loop_create_run(
    app: tauri::AppHandle,
    project_path: String,
    run_id: String,
) -> Result<CreatedRunPaths, String> {
    if !is_safe_run_id(&run_id) {
        return Err(format!(
            "run_id invalido: {run_id} (sólo [A-Za-z0-9_-])"
        ));
    }
    let globals_dir = prompts_dir(&app)?;

    tokio::task::spawn_blocking(move || -> Result<CreatedRunPaths, String> {
        // Asegurar globales primero — un run sin prompts no tiene sentido.
        ensure_dir_sync(&globals_dir)?;

        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Err(format!("project_path no es directorio: {project_path}"));
        }
        let run_dir = project.join(".loop").join("runs").join(&run_id);
        if run_dir.exists() {
            return Err(format!("run_dir ya existe: {run_dir:?}"));
        }
        std::fs::create_dir_all(&run_dir)
            .map_err(|e| format!("no pude crear {run_dir:?}: {e}"))?;

        let prompts_dir_run = run_dir.join("prompts");
        std::fs::create_dir_all(&prompts_dir_run)
            .map_err(|e| format!("no pude crear {prompts_dir_run:?}: {e}"))?;

        for name in PROMPT_NAMES.iter() {
            let source = globals_dir.join(name);
            let content = match std::fs::read_to_string(&source) {
                Ok(c) => c,
                Err(_) => {
                    // Si el global fue borrado entre el ensure y la copia,
                    // caemos al bundled.
                    bundled_content(name)
                        .ok_or_else(|| format!("seed bundled faltante para {name}"))?
                        .to_string()
                }
            };
            let dest = prompts_dir_run.join(name);
            write_atomic(&dest, &content)?;
        }

        Ok(CreatedRunPaths {
            run_dir: run_dir.to_string_lossy().to_string(),
            prompts_dir: prompts_dir_run.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn is_safe_run_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Nombres de archivo permitidos para `loop_read_run_file` / `loop_write_run_file`.
/// Sólo aceptamos componentes simples (sin separadores) y restringimos al set que
/// el flow del run usa actualmente — `01-problem-draft.md` (auto-save del chat),
/// `01-problem.md` (consolidación final), `02-phases.md` (manifest de fases del
/// paso 2 — JSON serializado de `Phase[]`). Mantenemos esto restrictivo a
/// propósito: los archivos por fase (`logic.md`, `visual.html`) viven en
/// subdirectorios y tienen sus propios comandos (`loop_*_phase_file`) abajo.
const ALLOWED_RUN_FILES: &[&str] = &["01-problem-draft.md", "01-problem.md", "02-phases.md"];

fn is_allowed_run_file(name: &str) -> bool {
    ALLOWED_RUN_FILES.iter().any(|n| *n == name)
}

/// Resuelve `<projectPath>/.loop/runs/<runId>/<file>` aplicando la misma
/// validación de `run_id` que `loop_create_run` + un allowlist de `file`. El
/// resultado es un path absoluto que el caller puede leer/escribir; el run_dir
/// debe existir (de lo contrario devolvemos error — no auto-creamos para no
/// enmascarar bugs de orden).
fn resolve_run_file(
    project_path: &str,
    run_id: &str,
    file: &str,
) -> Result<PathBuf, String> {
    if !is_safe_run_id(run_id) {
        return Err(format!("run_id invalido: {run_id}"));
    }
    if !is_allowed_run_file(file) {
        return Err(format!("nombre de archivo no permitido: {file}"));
    }
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Err(format!("project_path no es directorio: {project_path}"));
    }
    let run_dir = project.join(".loop").join("runs").join(run_id);
    if !run_dir.is_dir() {
        return Err(format!("run_dir no existe: {run_dir:?}"));
    }
    Ok(run_dir.join(file))
}

/// Lee un archivo del run. Si no existe, devuelve string vacío — el chat usa
/// esto al hidratar el draft de un run interrumpido (Section 9 hará el resume
/// formal; por ahora basta con tolerar "no existe" como "no hay draft").
#[tauri::command]
pub async fn loop_read_run_file(
    project_path: String,
    run_id: String,
    file: String,
) -> Result<String, String> {
    let target = resolve_run_file(&project_path, &run_id, &file)?;
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        match std::fs::read_to_string(&target) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("no pude leer {target:?}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Escribe un archivo del run de manera atómica (mismo `write_atomic` que los
/// prompts globales). El run_dir debe existir — se crea con `loop_create_run`.
#[tauri::command]
pub async fn loop_write_run_file(
    project_path: String,
    run_id: String,
    file: String,
    content: String,
) -> Result<(), String> {
    let target = resolve_run_file(&project_path, &run_id, &file)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> { write_atomic(&target, &content) })
        .await
        .map_err(|e| format!("join error: {e}"))?
}

// ---------------------------------------------------------------------------
// Section 5: comandos para fases del paso 2
// ---------------------------------------------------------------------------
//
// El paso 2 crea `<run>/phases/<NN>-<slug>/` por cada fase del manifest. Cada
// subdir contiene `logic.md` (siempre) y opcionalmente `visual.html`. Las
// operaciones del frontend (crear, listar, leer/escribir contenido, borrar)
// pasan por estos comandos para mantener la validación de paths centralizada
// (no exponemos un canal genérico de FS al webview).
//
// Decisiones:
// - Saneamos el `phaseSlug` con el mismo predicado que `run_id`: sólo
//   `[A-Za-z0-9_-]`. El frontend genera slugs como `01-init`, `02-render`.
// - Sólo permitimos `logic.md` y `visual.html` como archivos por fase.
// - `loop_list_phase_dirs` devuelve los subdirs ordenados para que el UI no
//   tenga que adivinar el orden — sólo refleja lo que hay en disco. La
//   topología (depends_on) la maneja el frontend leyendo `02-phases.md`.

const ALLOWED_PHASE_FILES: &[&str] = &["logic.md", "visual.html"];

fn is_allowed_phase_file(name: &str) -> bool {
    ALLOWED_PHASE_FILES.iter().any(|n| *n == name)
}

fn is_safe_phase_slug(slug: &str) -> bool {
    // Mismas reglas que `run_id`: no traversal, no separadores. El frontend
    // arma slugs como "01-init", "02-data-shape".
    is_safe_run_id(slug)
}

fn resolve_phases_dir(project_path: &str, run_id: &str) -> Result<PathBuf, String> {
    if !is_safe_run_id(run_id) {
        return Err(format!("run_id invalido: {run_id}"));
    }
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Err(format!("project_path no es directorio: {project_path}"));
    }
    let run_dir = project.join(".loop").join("runs").join(run_id);
    if !run_dir.is_dir() {
        return Err(format!("run_dir no existe: {run_dir:?}"));
    }
    Ok(run_dir.join("phases"))
}

fn resolve_phase_dir(
    project_path: &str,
    run_id: &str,
    phase_slug: &str,
) -> Result<PathBuf, String> {
    if !is_safe_phase_slug(phase_slug) {
        return Err(format!("phase_slug invalido: {phase_slug}"));
    }
    let phases = resolve_phases_dir(project_path, run_id)?;
    Ok(phases.join(phase_slug))
}

/// Crea (o asegura) `<run>/phases/<phase_slug>/` y devuelve el path absoluto.
/// `withVisual=true` también crea `visual.html` vacío para que el UI muestre
/// la tab de una. `logic.md` se crea siempre vacío si no existe — el agente
/// del paso 2 lo escribe después con el contenido inicial.
#[tauri::command]
pub async fn loop_create_phase_dir(
    project_path: String,
    run_id: String,
    phase_slug: String,
    with_visual: bool,
) -> Result<String, String> {
    let target = resolve_phase_dir(&project_path, &run_id, &phase_slug)?;
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        std::fs::create_dir_all(&target)
            .map_err(|e| format!("no pude crear {target:?}: {e}"))?;
        let logic = target.join("logic.md");
        if !logic.exists() {
            write_atomic(&logic, "")?;
        }
        if with_visual {
            let visual = target.join("visual.html");
            if !visual.exists() {
                write_atomic(&visual, "")?;
            }
        }
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Borra el dir de una fase. No falla si no existía — borrar es idempotente
/// desde la perspectiva del UI.
#[tauri::command]
pub async fn loop_delete_phase_dir(
    project_path: String,
    run_id: String,
    phase_slug: String,
) -> Result<(), String> {
    let target = resolve_phase_dir(&project_path, &run_id, &phase_slug)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        match std::fs::remove_dir_all(&target) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("no pude borrar {target:?}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Lee `<phase>/<file>`. `file` debe estar en `ALLOWED_PHASE_FILES`. Si el
/// archivo no existe, devuelve string vacío (el UI lo trata como "sin
/// contenido aún").
#[tauri::command]
pub async fn loop_read_phase_file(
    project_path: String,
    run_id: String,
    phase_slug: String,
    file: String,
) -> Result<String, String> {
    if !is_allowed_phase_file(&file) {
        return Err(format!("nombre de archivo no permitido: {file}"));
    }
    let phase = resolve_phase_dir(&project_path, &run_id, &phase_slug)?;
    let target = phase.join(&file);
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        match std::fs::read_to_string(&target) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("no pude leer {target:?}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Escribe `<phase>/<file>` atómicamente. Si el dir de la fase no existe, lo
/// crea — esto permite que el flow "agregar fase" cree el subdir al guardar el
/// primer contenido. `file` debe estar en `ALLOWED_PHASE_FILES`.
#[tauri::command]
pub async fn loop_write_phase_file(
    project_path: String,
    run_id: String,
    phase_slug: String,
    file: String,
    content: String,
) -> Result<(), String> {
    if !is_allowed_phase_file(&file) {
        return Err(format!("nombre de archivo no permitido: {file}"));
    }
    let phase = resolve_phase_dir(&project_path, &run_id, &phase_slug)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&phase)
            .map_err(|e| format!("no pude crear {phase:?}: {e}"))?;
        let target = phase.join(&file);
        write_atomic(&target, &content)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Estado en disco de una fase: indica si `logic.md` / `visual.html` están
/// presentes Y tienen contenido no-vacío. El UI lo usa para mostrar badges
/// `md` / `html` y para habilitar el botón "→ Paso 3" (todas las fases con
/// `hasLogic=true`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseDirStatus {
    pub slug: String,
    pub has_logic: bool,
    pub has_visual: bool,
}

/// Lista los subdirs de `<run>/phases/`. Devuelve `Vec<PhaseDirStatus>` con un
/// flag por archivo. Ordena por nombre para que el UI tenga un orden
/// predecible aún si el manifest de `02-phases.md` se corrompe. Si el dir
/// `phases/` no existe (run sin paso 2 aún), devuelve lista vacía.
#[tauri::command]
pub async fn loop_list_phase_dirs(
    project_path: String,
    run_id: String,
) -> Result<Vec<PhaseDirStatus>, String> {
    let phases = resolve_phases_dir(&project_path, &run_id)?;
    tokio::task::spawn_blocking(move || -> Result<Vec<PhaseDirStatus>, String> {
        let entries = match std::fs::read_dir(&phases) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("no pude listar {phases:?}: {e}")),
        };
        let mut out: Vec<PhaseDirStatus> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let slug = entry.file_name().to_string_lossy().to_string();
            if !is_safe_phase_slug(&slug) {
                continue;
            }
            let logic = path.join("logic.md");
            let visual = path.join("visual.html");
            out.push(PhaseDirStatus {
                slug,
                has_logic: file_has_content(&logic),
                has_visual: file_has_content(&visual),
            });
        }
        out.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn file_has_content(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(m) => m.is_file() && m.len() > 0,
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Section 7: outputs/<phase>/<agent>.{md,diff}, state.json, git diff snapshots
// ---------------------------------------------------------------------------
//
// El engine secuencial del paso 3 (run-scheduler.ts) persiste los outputs de
// cada agente y un snapshot del diff del FS antes/después de cada agente. La
// estructura es `<run>/outputs/<phase_slug>/<agent>.<ext>` donde `agent` está
// en `ALLOWED_OUTPUT_AGENTS` y `ext` es `md` o `diff`. Además, el run completo
// guarda su estado serializable en `<run>/state.json` (rotado atómicamente
// para resume — Section 9 amplía el schema).
//
// Decisiones:
// - Allowlist estricto de agentes y extensiones — mismo razonamiento que los
//   otros comandos (no abrimos un canal genérico de FS al webview).
// - `git diff` lo corremos vía `git` en el `cwd` del project. Si el project no
//   está bajo git, devolvemos `""` como diff sin error — el snapshot vacío es
//   semánticamente correcto ("no había cambios trackeables").
// - El comando combina `git diff` (working tree vs HEAD, incl. untracked
//   parciales via `--no-index` no es escalable; usamos `--stat` + `diff` y
//   listamos untracked aparte para una vista útil sin bombardear el output).

const ALLOWED_OUTPUT_AGENTS: &[&str] = &[
    "analysis",
    "implementation",
    "review",
    "knowledge",
    "integration",
];
const ALLOWED_OUTPUT_EXTENSIONS: &[&str] = &["md", "diff"];

fn is_allowed_output_agent(agent: &str) -> bool {
    ALLOWED_OUTPUT_AGENTS.contains(&agent)
}

fn is_allowed_output_extension(ext: &str) -> bool {
    ALLOWED_OUTPUT_EXTENSIONS.contains(&ext)
}

/// Resuelve `<run>/outputs/<phase_slug>/<agent>.<ext>` aplicando la misma
/// validación que el resto. Crea el dir si no existe — el scheduler escribe
/// outputs antes de que `phases/<slug>/` esté garantizado.
fn resolve_output_file(
    project_path: &str,
    run_id: &str,
    phase_slug: &str,
    agent: &str,
    ext: &str,
) -> Result<PathBuf, String> {
    if !is_safe_run_id(run_id) {
        return Err(format!("run_id invalido: {run_id}"));
    }
    if !is_safe_phase_slug(phase_slug) {
        return Err(format!("phase_slug invalido: {phase_slug}"));
    }
    if !is_allowed_output_agent(agent) {
        return Err(format!("agent no permitido: {agent}"));
    }
    if !is_allowed_output_extension(ext) {
        return Err(format!("extensión no permitida: {ext}"));
    }
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Err(format!("project_path no es directorio: {project_path}"));
    }
    let run_dir = project.join(".loop").join("runs").join(run_id);
    if !run_dir.is_dir() {
        return Err(format!("run_dir no existe: {run_dir:?}"));
    }
    Ok(run_dir
        .join("outputs")
        .join(phase_slug)
        .join(format!("{agent}.{ext}")))
}

/// Lee un output de agente. Devuelve string vacío si no existe (no es error —
/// el scheduler chequea presencia antes de invocar la siguiente etapa).
#[tauri::command]
pub async fn loop_read_output_file(
    project_path: String,
    run_id: String,
    phase_slug: String,
    agent: String,
    ext: String,
) -> Result<String, String> {
    let target = resolve_output_file(&project_path, &run_id, &phase_slug, &agent, &ext)?;
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        match std::fs::read_to_string(&target) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("no pude leer {target:?}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Escribe un output de agente atómicamente. Crea `outputs/<phase>/` si no
/// existe.
#[tauri::command]
pub async fn loop_write_output_file(
    project_path: String,
    run_id: String,
    phase_slug: String,
    agent: String,
    ext: String,
    content: String,
) -> Result<(), String> {
    let target = resolve_output_file(&project_path, &run_id, &phase_slug, &agent, &ext)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> { write_atomic(&target, &content) })
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Resuelve `<run>/state.json`. El run_dir debe existir.
fn resolve_state_file(project_path: &str, run_id: &str) -> Result<PathBuf, String> {
    if !is_safe_run_id(run_id) {
        return Err(format!("run_id invalido: {run_id}"));
    }
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Err(format!("project_path no es directorio: {project_path}"));
    }
    let run_dir = project.join(".loop").join("runs").join(run_id);
    if !run_dir.is_dir() {
        return Err(format!("run_dir no existe: {run_dir:?}"));
    }
    Ok(run_dir.join("state.json"))
}

/// Lee `<run>/state.json`. Si no existe, devuelve string vacío — el scheduler
/// usa eso como "primer arranque del run, escribí un state inicial".
#[tauri::command]
pub async fn loop_read_state_file(
    project_path: String,
    run_id: String,
) -> Result<String, String> {
    let target = resolve_state_file(&project_path, &run_id)?;
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        match std::fs::read_to_string(&target) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("no pude leer {target:?}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Escribe `<run>/state.json` atómicamente. El frontend pasa el JSON
/// serializado (no validamos schema acá — el TS es source of truth).
#[tauri::command]
pub async fn loop_write_state_file(
    project_path: String,
    run_id: String,
    content: String,
) -> Result<(), String> {
    let target = resolve_state_file(&project_path, &run_id)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> { write_atomic(&target, &content) })
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Snapshot del diff actual del repo en formato unified. Combina:
/// - `git diff HEAD` (tracked + staged + unstaged vs HEAD).
/// - Listado de untracked files (línea por archivo, sin contenido — para no
///   inflar el output con binarios o assets grandes).
///
/// Si el `project_path` no es un repo git, devuelve string vacío (semántica
/// "no hay diff trackeable"). Si `git` no está en PATH, devuelve un comentario
/// explicativo como diff — no es error fatal.
///
/// Decisión: snapshot post-hoc en lugar de `git stash` real. design.md sec
/// "Permisos de FS sin restricción + auditoría" menciona stash, pero stash
/// real interfiere con el working state del usuario. Un `git diff HEAD`
/// captura el delta sin mover archivos. Si más adelante hace falta una vista
/// truly side-effect-free, podemos volver a stash con `push --include-untracked
/// --keep-index` + `pop`, pero eso es más invasivo y mengua si el usuario
/// tiene cambios encolados.
#[tauri::command]
pub async fn loop_git_diff_snapshot(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> { git_diff_sync(&project_path) })
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn git_diff_sync(project_path: &str) -> Result<String, String> {
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Ok(String::new());
    }
    if !project.join(".git").exists() {
        // No es un repo git — snapshot vacío.
        return Ok(String::new());
    }

    let diff_out = Command::new("git")
        .args(["diff", "HEAD"])
        .current_dir(&project)
        .stdin(Stdio::null())
        .output();
    let diff = match diff_out {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
        Ok(out) => {
            // exit != 0 puede pasar si no hay HEAD aún (repo recién init). En
            // ese caso devolvemos snapshot vacío + nota.
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Ok(format!("# git diff fallo: {}\n", stderr.trim()));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok("# git no está en PATH — snapshot de diff no disponible\n".to_string());
        }
        Err(e) => return Err(format!("error invocando git: {e}")),
    };

    // Listado de untracked sin contenido — sólo paths para mantener el diff
    // legible incluso si hay assets pesados.
    let untracked_out = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(&project)
        .stdin(Stdio::null())
        .output();
    let untracked = match untracked_out {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
        _ => String::new(),
    };

    let mut combined = String::new();
    combined.push_str(&diff);
    let untracked_trimmed = untracked.trim();
    if !untracked_trimmed.is_empty() {
        if !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str("\n# Untracked files (paths only):\n");
        for line in untracked_trimmed.lines() {
            combined.push_str(&format!("# - {line}\n"));
        }
    }
    Ok(combined)
}

// ---------------------------------------------------------------------------
// Section 8: outputs por batch del modo híbrido
// ---------------------------------------------------------------------------
//
// El engine híbrido (`run-scheduler.ts`) corre fases en batches paralelos y
// usa un agente integrador entre cada batch. El integrador consume todos los
// outputs/diffs del batch y produce un `knowledge.md` consolidado que vive en
// `<run>/outputs/batches/batch-<N>/knowledge.md`. Section 8.6 hace que ese
// conocimiento sea input adicional para las fases del batch siguiente — por
// eso el frontend necesita read/write sobre este path.
//
// Decisión: tratamos `batch-<N>` como un "slug" idéntico a los `phase_slug` ya
// existentes (mismo predicado de validación). La extensión sólo es `md` (los
// diffs por batch no se materializan — el integrador los referencia por fase
// vía `loop_read_output_file`).
//
// El `batch_id` se sanea con `safe_run_id` (el frontend genera "batch-0",
// "batch-1", ...). El nombre de archivo está restringido al allowlist abajo.

const ALLOWED_BATCH_FILES: &[&str] = &["knowledge.md"];

fn is_allowed_batch_file(name: &str) -> bool {
    ALLOWED_BATCH_FILES.iter().any(|n| *n == name)
}

/// Resuelve `<run>/outputs/batches/<batch_id>/<file>`. Aplica las mismas
/// validaciones que los demás comandos del módulo — `run_id` y `batch_id`
/// pasan por `is_safe_run_id`, `file` por `is_allowed_batch_file`. Si el
/// `run_dir` no existe es error; el dir del batch se crea on-demand en write.
fn resolve_batch_file(
    project_path: &str,
    run_id: &str,
    batch_id: &str,
    file: &str,
) -> Result<PathBuf, String> {
    if !is_safe_run_id(run_id) {
        return Err(format!("run_id invalido: {run_id}"));
    }
    if !is_safe_run_id(batch_id) {
        return Err(format!("batch_id invalido: {batch_id}"));
    }
    if !is_allowed_batch_file(file) {
        return Err(format!("nombre de archivo no permitido: {file}"));
    }
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Err(format!("project_path no es directorio: {project_path}"));
    }
    let run_dir = project.join(".loop").join("runs").join(run_id);
    if !run_dir.is_dir() {
        return Err(format!("run_dir no existe: {run_dir:?}"));
    }
    Ok(run_dir
        .join("outputs")
        .join("batches")
        .join(batch_id)
        .join(file))
}

/// Lee el output consolidado del integrador de un batch. Devuelve string
/// vacío si no existe (semántica "todavía no se generó").
#[tauri::command]
pub async fn loop_read_batch_file(
    project_path: String,
    run_id: String,
    batch_id: String,
    file: String,
) -> Result<String, String> {
    let target = resolve_batch_file(&project_path, &run_id, &batch_id, &file)?;
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        match std::fs::read_to_string(&target) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("no pude leer {target:?}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Escribe el output consolidado del integrador atómicamente. Crea el
/// `outputs/batches/<batch_id>/` si no existe.
#[tauri::command]
pub async fn loop_write_batch_file(
    project_path: String,
    run_id: String,
    batch_id: String,
    file: String,
    content: String,
) -> Result<(), String> {
    let target = resolve_batch_file(&project_path, &run_id, &batch_id, &file)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> { write_atomic(&target, &content) })
        .await
        .map_err(|e| format!("join error: {e}"))?
}

// Nota: Section 8.4 (detección de conflictos entre fases del batch) NO necesita
// un comando dedicado porque la detección se hace en TS sobre los diffs leídos
// vía `loop_read_output_file`. Dejamos esta nota acá por si en el futuro alguien
// busca dónde está implementado el `git diff --check`.

// ---------------------------------------------------------------------------
// Section 9: detección de runs interrumpidos
// ---------------------------------------------------------------------------
//
// Al abrir `/loop` sobre un project, escaneamos `<project>/.loop/runs/` buscando
// runs cuyo `state.json` tenga `status: "running"` y un `lastHeartbeat` viejo
// (> N×3 segundos, default N=5s ⇒ 15s). Los reportamos al frontend para que
// muestre un banner "run interrumpido detectado · ¿retomar?".
//
// Decisión: hacemos el scan en Rust en lugar de exponer un `list_dirs` genérico
// porque (a) leemos los `state.json` parcialmente y filtramos en el mismo IO
// pass, (b) ya tenemos toda la maquinaria de validación de paths en este
// módulo, (c) evitamos exponer un canal de FS sin allowlist.

/// Resumen de un run interrumpido encontrado en disco. Suficiente para que el
/// banner muestre el run y permita al usuario decidir "retomar" o "archivar".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedRun {
    /// run_id (último componente del path).
    pub run_id: String,
    /// Timestamp epoch ms del último heartbeat persistido (0 si no había).
    pub last_heartbeat: i64,
    /// Edad del heartbeat en milisegundos al momento del scan. Para el UI.
    pub age_ms: i64,
}

/// Escanea `<project>/.loop/runs/` buscando runs interrumpidos. Un run cuenta
/// como interrumpido si:
///   - existe `<run>/state.json`,
///   - el JSON tiene `status: "running"` (o `"paused"` con heartbeat viejo —
///     un crash a mitad de transición puede dejarlo en cualquier estado activo),
///   - `lastHeartbeat` es viejo: `(now - lastHeartbeat) > stale_threshold_ms`.
///
/// `stale_threshold_ms` default 15s (N=5s × 3) — coincide con el design.md
/// "frecuencia del heartbeat".
///
/// El scan tolera errores por run individual: si un `state.json` está
/// corrupto, lo saltamos y seguimos con los demás.
#[tauri::command]
pub async fn loop_list_interrupted_runs(
    project_path: String,
    stale_threshold_ms: Option<i64>,
) -> Result<Vec<InterruptedRun>, String> {
    let threshold = stale_threshold_ms.unwrap_or(15_000).max(0);
    tokio::task::spawn_blocking(move || -> Result<Vec<InterruptedRun>, String> {
        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Ok(Vec::new());
        }
        let runs_dir = project.join(".loop").join("runs");
        let entries = match std::fs::read_dir(&runs_dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("no pude listar {runs_dir:?}: {e}")),
        };
        let now = epoch_ms_now();
        let mut out: Vec<InterruptedRun> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let run_id = entry.file_name().to_string_lossy().to_string();
            if !is_safe_run_id(&run_id) {
                continue;
            }
            let state_path = path.join("state.json");
            let raw = match std::fs::read_to_string(&state_path) {
                Ok(s) => s,
                Err(_) => continue, // sin state.json, no es un run interrumpido reconocible
            };
            // Parseo tolerante: leemos sólo los campos que necesitamos para el
            // gate (status + lastHeartbeat). Si el JSON está corrupto, lo
            // saltamos sin tirar.
            let parsed: serde_json::Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let status = parsed
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let is_active = matches!(status, "running" | "paused");
            if !is_active {
                continue;
            }
            let last_heartbeat = parsed
                .get("lastHeartbeat")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let age = if last_heartbeat > 0 {
                now - last_heartbeat
            } else {
                // Sin heartbeat es semánticamente lo mismo que infinitamente viejo
                // (probablemente un crash muy temprano). Lo tratamos como
                // interrumpido si threshold > 0.
                i64::MAX
            };
            if age >= threshold {
                out.push(InterruptedRun {
                    run_id,
                    last_heartbeat,
                    age_ms: if age == i64::MAX { age } else { age.max(0) },
                });
            }
        }
        // Más reciente primero para que el banner muestre el más relevante
        // arriba si hay más de uno (caso raro pero posible).
        out.sort_by(|a, b| b.last_heartbeat.cmp(&a.last_heartbeat));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Resumen ligero de un run en disco. Se usa en el picker de "runs anteriores"
/// del paso 1: ofrece al usuario retomar un run viejo (incluso uno donde sólo
/// se consolidó el `01-problem.md` sin ejecutar el scheduler).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    /// Epoch ms del archivo más reciente del run (draft/consolidated/state).
    pub last_modified_ms: i64,
    pub has_draft: bool,
    pub has_consolidated: bool,
    pub has_phases: bool,
    /// Primera línea no vacía del consolidado (o del draft) — para preview.
    pub preview: Option<String>,
}

/// Lista todos los runs del project bajo `<project>/.loop/runs/`. Tolerante a
/// errores por run (un dir corrupto no rompe el scan). Ordena por
/// `last_modified_ms` descendente — el más reciente primero.
#[tauri::command]
pub async fn loop_list_runs(project_path: String) -> Result<Vec<RunSummary>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<RunSummary>, String> {
        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Ok(Vec::new());
        }
        let runs_dir = project.join(".loop").join("runs");
        let entries = match std::fs::read_dir(&runs_dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("no pude listar {runs_dir:?}: {e}")),
        };
        let mut out: Vec<RunSummary> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let run_id = entry.file_name().to_string_lossy().to_string();
            if !is_safe_run_id(&run_id) {
                continue;
            }
            let draft_path = path.join("01-problem-draft.md");
            let consolidated_path = path.join("01-problem.md");
            let phases_path = path.join("02-phases.md");
            let has_draft = draft_path.is_file();
            let has_consolidated = consolidated_path.is_file();
            let has_phases = phases_path.is_file();
            // Saltamos dirs vacíos (sin ningún artefacto reconocible).
            if !has_draft && !has_consolidated && !has_phases {
                continue;
            }
            let last_modified_ms = newest_mtime_ms(&path).unwrap_or(0);
            let preview = if has_consolidated {
                first_meaningful_line(&consolidated_path)
            } else if has_draft {
                first_user_message_from_draft(&draft_path)
            } else {
                None
            };
            out.push(RunSummary {
                run_id,
                last_modified_ms,
                has_draft,
                has_consolidated,
                has_phases,
                preview,
            });
        }
        out.sort_by(|a, b| b.last_modified_ms.cmp(&a.last_modified_ms));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn newest_mtime_ms(dir: &Path) -> Option<i64> {
    let mut newest: i64 = 0;
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        let ms = match p.metadata().and_then(|m| m.modified()) {
            Ok(t) => t
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
            Err(_) => 0,
        };
        if ms > newest {
            newest = ms;
        }
    }
    if newest == 0 {
        None
    } else {
        Some(newest)
    }
}

fn first_meaningful_line(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        return Some(truncate_preview(trimmed));
    }
    None
}

fn first_user_message_from_draft(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let mut in_user_section = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("### Usuario") {
            in_user_section = true;
            continue;
        }
        if trimmed.starts_with("###") || trimmed.starts_with("##") {
            in_user_section = false;
            continue;
        }
        if in_user_section && !trimmed.is_empty() {
            return Some(truncate_preview(trimmed));
        }
    }
    None
}

fn truncate_preview(s: &str) -> String {
    const LIMIT: usize = 140;
    if s.chars().count() <= LIMIT {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(LIMIT).collect();
        out.push('…');
        out
    }
}

/// Archivar un run: lo movemos de `<project>/.loop/runs/<id>/` a
/// `<project>/.loop/archived/<id>/`. El usuario lo invoca desde el banner del
/// resume cuando decide descartar un run interrumpido sin perderlo del todo —
/// queda accesible para auditoría manual.
///
/// Si el destino ya existe (caso de un archivado previo con el mismo id, que
/// no debería pasar con runIds UUID pero defensivo) le agregamos un sufijo
/// timestamp.
#[tauri::command]
pub async fn loop_archive_run(
    project_path: String,
    run_id: String,
) -> Result<String, String> {
    if !is_safe_run_id(&run_id) {
        return Err(format!("run_id invalido: {run_id}"));
    }
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Err(format!("project_path no es directorio: {project_path}"));
        }
        let source = project.join(".loop").join("runs").join(&run_id);
        if !source.is_dir() {
            return Err(format!("run no existe: {source:?}"));
        }
        let archived_root = project.join(".loop").join("archived");
        std::fs::create_dir_all(&archived_root)
            .map_err(|e| format!("no pude crear {archived_root:?}: {e}"))?;
        let mut target = archived_root.join(&run_id);
        if target.exists() {
            let stamp = epoch_ms_now();
            target = archived_root.join(format!("{run_id}-{stamp}"));
        }
        std::fs::rename(&source, &target)
            .map_err(|e| format!("no pude mover {source:?} -> {target:?}: {e}"))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Borra outputs parciales de un run: archivos `<agent>.md` que no tienen un
/// `<agent>.diff` companion. La presencia del `.diff` indica que el scheduler
/// terminó de procesar la etapa atómicamente — sin él, el `.md` es output
/// parcial de un agente que crasheó a mitad y debe reejecutarse.
///
/// Sobre los outputs del integrador (`outputs/batches/<batch>/knowledge.md`):
/// no tienen `.diff` companion, así que no los tocamos acá. El resumen del
/// scheduler los re-genera si el integrador tiene status != done.
#[tauri::command]
pub async fn loop_discard_partial_outputs(
    project_path: String,
    run_id: String,
) -> Result<Vec<String>, String> {
    if !is_safe_run_id(&run_id) {
        return Err(format!("run_id invalido: {run_id}"));
    }
    tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Err(format!("project_path no es directorio: {project_path}"));
        }
        let outputs = project.join(".loop").join("runs").join(&run_id).join("outputs");
        let phase_entries = match std::fs::read_dir(&outputs) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("no pude listar {outputs:?}: {e}")),
        };
        let mut discarded: Vec<String> = Vec::new();
        for phase_entry in phase_entries.flatten() {
            let phase_path = phase_entry.path();
            if !phase_path.is_dir() {
                continue;
            }
            // Saltamos el subdir `batches/` — sus outputs no tienen `.diff`.
            if phase_entry.file_name() == "batches" {
                continue;
            }
            let files = match std::fs::read_dir(&phase_path) {
                Ok(e) => e,
                Err(_) => continue,
            };
            // Mapa de stems disponibles: nombre del agente -> { has_md, has_diff }.
            let mut state: std::collections::HashMap<String, (bool, bool)> = std::collections::HashMap::new();
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                if let Some(stem) = name.strip_suffix(".md") {
                    state.entry(stem.to_string()).or_default().0 = true;
                } else if let Some(stem) = name.strip_suffix(".diff") {
                    state.entry(stem.to_string()).or_default().1 = true;
                }
            }
            for (stem, (has_md, has_diff)) in state {
                if has_md && !has_diff && is_allowed_output_agent(&stem) {
                    let target = phase_path.join(format!("{stem}.md"));
                    if std::fs::remove_file(&target).is_ok() {
                        discarded.push(target.to_string_lossy().to_string());
                    }
                }
            }
        }
        Ok(discarded)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn epoch_ms_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Resultado de `loop_validate_cli_model`. `ok=true` => slot verde. `ok=false`
/// con `reason` legible para mostrar al usuario (ej. "claude no encontrado en
/// PATH", "modelo no disponible: 404").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliValidation {
    pub ok: bool,
    pub reason: Option<String>,
}

impl CliValidation {
    fn ok() -> Self {
        Self {
            ok: true,
            reason: None,
        }
    }
    fn err(reason: impl Into<String>) -> Self {
        Self {
            ok: false,
            reason: Some(reason.into()),
        }
    }
}

/// Chequea: (1) el binario del CLI está en PATH, (2) un ping mínimo al modelo
/// no falla. El ping usa un prompt trivial (`"ok"`) con timeout corto. No es a
/// prueba de balas (la red puede fallar por otras razones), pero es suficiente
/// para detectar typos de modelo / CLIs desinstalados / claves no
/// configuradas. La decisión es alinearse con design.md decision #8 ("sin
/// auto-fallback") y dejar que el usuario corrija manualmente.
#[tauri::command]
pub async fn loop_validate_cli_model(cli: String, model: String) -> Result<CliValidation, String> {
    let cli_lower = cli.to_ascii_lowercase();
    if !matches!(cli_lower.as_str(), "claude" | "codex" | "opencode") {
        return Ok(CliValidation::err(format!("CLI no soportado: {cli}")));
    }

    let cli_for_task = cli_lower.clone();
    let model_for_task = model.clone();
    let join = tokio::task::spawn_blocking(move || -> CliValidation {
        validate_sync(&cli_for_task, &model_for_task)
    });

    // 15s es generoso para un ping; el default de `run_loop_agent` es 300s
    // pero acá sólo es validación. Si tarda más, asumimos que algo está mal.
    match tokio::time::timeout(Duration::from_secs(15), join).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Ok(CliValidation::err(format!("join error: {e}"))),
        Err(_) => Ok(CliValidation::err("timeout validando")),
    }
}

fn validate_sync(cli: &str, model: &str) -> CliValidation {
    // (1) Binario en PATH. `which` no es portable; usamos `<cli> --version`
    // que está en los 3 CLIs y devuelve rápido.
    let version_check = Command::new(cli)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match version_check {
        Ok(s) if s.success() => {}
        Ok(s) => return CliValidation::err(format!("{cli} --version exit {s}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return CliValidation::err(format!("{cli} no encontrado en PATH"));
        }
        Err(e) => return CliValidation::err(format!("error invocando {cli}: {e}")),
    }

    // (2) Ping al modelo. Cada CLI tiene su forma; usamos la misma estructura
    // que en `loop_cli::invoke_*` pero con el prompt mínimo y output ignorado.
    let result = match cli {
        "claude" => Command::new("claude")
            .args(["-p", "ok", "--output-format", "json", "--model", model])
            .stdin(Stdio::null())
            .output(),
        "codex" => Command::new("codex")
            .args(["exec", "--model", model, "ok"])
            .stdin(Stdio::null())
            .output(),
        "opencode" => Command::new("opencode")
            .args(["run", "--format", "json", "--model", model, "ok"])
            .stdin(Stdio::null())
            .output(),
        _ => return CliValidation::err("CLI no soportado"),
    };

    match result {
        Ok(out) if out.status.success() => CliValidation::ok(),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            // Heurística: si stderr menciona "model" lo etiquetamos como
            // problema de modelo. Si no, pasamos el primer renglón del stderr.
            let snippet = stderr.lines().next().unwrap_or("").trim();
            if stderr.to_lowercase().contains("model") {
                CliValidation::err(format!("modelo no disponible: {snippet}"))
            } else {
                CliValidation::err(format!("ping fallo: {snippet}"))
            }
        }
        Err(e) => CliValidation::err(format!("error pingueando {cli}: {e}")),
    }
}

/// Escribe `content` a `target` de manera atómica: temp file en el mismo dir,
/// fsync opcional, rename. Si falla en algún paso, no deja archivos parciales
/// donde antes había uno válido. No usamos `tempfile::NamedTempFile` aquí
/// porque su API moverse a otro dir no es atómica entre filesystems — esta
/// vesion mantiene todo en el dir destino.
fn write_atomic(target: &Path, content: &str) -> Result<(), String> {
    let parent = target.parent().ok_or_else(|| {
        format!("path sin parent dir: {target:?}")
    })?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("no pude crear {parent:?}: {e}"))?;

    let tmp = parent.join(format!(
        ".{}.tmp",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("prompt")
    ));

    std::fs::write(&tmp, content).map_err(|e| format!("no pude escribir tmp {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, target).map_err(|e| {
        // Limpieza best-effort.
        let _ = std::fs::remove_file(&tmp);
        format!("no pude renombrar {tmp:?} -> {target:?}: {e}")
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_content_covers_all_7() {
        for name in PROMPT_NAMES.iter() {
            let content = bundled_content(name).expect("bundled missing");
            assert!(!content.is_empty(), "bundled vacío para {name}");
        }
    }

    #[test]
    fn bundled_content_rejects_unknown() {
        assert!(bundled_content("anything-else.md").is_none());
    }

    #[test]
    fn safe_run_id_accepts_alphanumeric_dashes_underscores() {
        assert!(is_safe_run_id("run-2026-06-24"));
        assert!(is_safe_run_id("abc_123"));
        assert!(is_safe_run_id("a"));
    }

    #[test]
    fn safe_run_id_rejects_traversal_and_separators() {
        assert!(!is_safe_run_id(""));
        assert!(!is_safe_run_id(".."));
        assert!(!is_safe_run_id("a/b"));
        assert!(!is_safe_run_id("a b"));
        assert!(!is_safe_run_id("a.b"));
        assert!(!is_safe_run_id(&"a".repeat(200)));
    }

    #[test]
    fn ensure_dir_creates_missing_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("prompts");
        let restored = ensure_dir_sync(&dir).unwrap();
        assert_eq!(restored.len(), PROMPT_NAMES.len());
        for name in PROMPT_NAMES.iter() {
            assert!(dir.join(name).exists(), "{name} no fue restaurado");
        }
    }

    #[test]
    fn ensure_dir_does_not_overwrite_existing_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("prompts");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("analysis.md"), "MI EDIT").unwrap();

        let restored = ensure_dir_sync(&dir).unwrap();
        // 6 archivos restaurados, no el editado.
        assert_eq!(restored.len(), PROMPT_NAMES.len() - 1);
        assert!(!restored.contains(&"analysis.md".to_string()));
        assert_eq!(
            std::fs::read_to_string(dir.join("analysis.md")).unwrap(),
            "MI EDIT"
        );
    }

    #[test]
    fn write_atomic_creates_target_and_no_tmp_remainder() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("hello.md");
        write_atomic(&target, "contenido").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "contenido");

        // No deben quedar .tmp huérfanos en el dir.
        let leftovers = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with('.')
            })
            .count();
        assert_eq!(leftovers, 0);
    }
}
