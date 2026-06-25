//! Wrapper de subprocesos para los CLIs LLM usados por la ventana `/loop`.
//!
//! Expone un único comando Tauri `run_loop_agent` que normaliza la invocación
//! one-shot de `claude`, `codex` y `opencode` a un [`AgentResult`] común. La
//! decisión de mantener esto en un módulo aparte (en lugar de extender
//! `commands.rs`) refleja la separación de capas que ya usa el repo: el módulo
//! `pty.rs` aísla el wrapping de `portable_pty`, y este módulo hace lo análogo
//! para el patrón one-shot con `std::process::Command::output()`.
//!
//! Diseño técnico clave:
//! - `tokio::time::timeout` envuelve la ejecución bloqueante vía
//!   `tokio::task::spawn_blocking`. El default es 300s (alineado con el design
//!   doc, sección "Risks", fila del subproceso colgado).
//! - El parseo de outputs es CLI-específico (cada CLI tiene un formato distinto)
//!   y vive en funciones `parse_*` separadas para poder testearlas de manera
//!   aislada en el futuro.
//! - Errores se devuelven como `AgentResult { error: Some(...) }` en vez de
//!   `Err(...)` cuando se trata de fallos esperables del CLI (exit != 0, JSON
//!   malformado). Reservamos `Err(...)` para fallos del wrapper (timeout, CLI
//!   no encontrado, IO fatal). Esto le da al frontend un canal uniforme para
//!   surfacear warnings sin tener que distinguir excepciones de status fields.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::time::timeout;

/// Default timeout en segundos para una invocación de agente. Alineado con el
/// design doc (300s). Configurable por argumento del comando.
const DEFAULT_TIMEOUT_SECS: u64 = 300;

/// Output normalizado de cualquier CLI LLM invocado por el módulo `/loop`.
///
/// Los campos `tokens_in`, `tokens_out`, `cost_usd` y `session_id` son
/// opcionales porque no todos los CLIs los exponen en su modo one-shot (ej.
/// `opencode` no reporta costo). `text` siempre se intenta poblar — si no hay
/// nada, queda como string vacío y `error` debería estar seteado.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResult {
    /// El último mensaje del agente (el "result" del run one-shot).
    pub text: String,
    /// Tokens de entrada reportados por el CLI, si están disponibles.
    pub tokens_in: Option<u64>,
    /// Tokens de salida reportados por el CLI, si están disponibles.
    pub tokens_out: Option<u64>,
    /// Costo en USD reportado por el CLI, si está disponible.
    pub cost_usd: Option<f64>,
    /// ID de sesión del CLI (útil sólo para debugging — no usamos sesiones
    /// persistentes, ver design decision #3).
    pub session_id: Option<String>,
    /// Mensaje de error legible si la invocación devolvió exit != 0 o el
    /// output no pudo ser parseado. `None` indica éxito limpio.
    pub error: Option<String>,
}

impl AgentResult {
    fn empty_with_error(message: impl Into<String>) -> Self {
        Self {
            text: String::new(),
            tokens_in: None,
            tokens_out: None,
            cost_usd: None,
            session_id: None,
            error: Some(message.into()),
        }
    }
}

/// Comando Tauri que invoca el CLI configurado en modo one-shot y devuelve un
/// [`AgentResult`] normalizado.
///
/// `cli` es uno de `"claude" | "codex" | "opencode"`. Otros valores devuelven
/// `Err(...)` inmediato.
///
/// `system_prompt_path` y `user_input` se pasan al CLI como flags/stdin según
/// la convención de cada uno (ver funciones `invoke_*`).
///
/// `timeout_secs` por debajo de 1 se sustituye por [`DEFAULT_TIMEOUT_SECS`].
#[tauri::command]
pub async fn run_loop_agent(
    cli: String,
    model: String,
    cwd: String,
    system_prompt_path: Option<String>,
    user_input: String,
    timeout_secs: Option<u64>,
    session_id: Option<String>,
) -> Result<AgentResult, String> {
    let secs = timeout_secs
        .filter(|s| *s >= 1)
        .unwrap_or(DEFAULT_TIMEOUT_SECS);

    let cli_lower = cli.to_ascii_lowercase();

    let join = tokio::task::spawn_blocking(move || -> Result<AgentResult, String> {
        let sid = session_id.as_deref();
        match cli_lower.as_str() {
            "claude" => invoke_claude(&model, &cwd, system_prompt_path.as_deref(), &user_input, sid),
            "codex" => invoke_codex(&model, &cwd, system_prompt_path.as_deref(), &user_input, sid),
            "opencode" => invoke_opencode(&model, &cwd, system_prompt_path.as_deref(), &user_input, sid),
            other => Err(format!("CLI no soportado: {other}")),
        }
    });

    match timeout(Duration::from_secs(secs), join).await {
        Ok(Ok(Ok(result))) => Ok(result),
        Ok(Ok(Err(err))) => Ok(AgentResult::empty_with_error(err)),
        Ok(Err(join_err)) => Err(format!("loop_agent join error: {join_err}")),
        Err(_) => Err(format!("timeout despues de {secs}s invocando {cli}")),
    }
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

/// Invoca `claude -p <input> --output-format json --model <model> [--append-system-prompt @file]`.
///
/// `claude` con `--output-format json` devuelve un único objeto JSON con la
/// shape (entre otros campos): `{ "result": "...", "session_id": "...",
/// "total_cost_usd": 0.0, "usage": { "input_tokens": 0, "output_tokens": 0 },
/// "is_error": false }`.
fn invoke_claude(
    model: &str,
    cwd: &str,
    system_prompt_path: Option<&str>,
    user_input: &str,
    session_id: Option<&str>,
) -> Result<AgentResult, String> {
    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg(user_input)
        .arg("--output-format")
        .arg("json")
        .arg("--model")
        .arg(model);

    if let Some(sid) = session_id {
        // Resume: claude reusa la sesión previa (incluyendo el system prompt
        // que ya tenía). No re-appendeamos system prompt: claude lo conserva.
        cmd.arg("--resume").arg(sid);
    } else if let Some(path) = system_prompt_path {
        // Primer turno con esta sesión: incluimos el system prompt; futuros
        // resumes lo heredan.
        let content =
            std::fs::read_to_string(path).map_err(|e| format!("no pude leer system prompt: {e}"))?;
        cmd.arg("--append-system-prompt").arg(content);
    }

    let output = run_command(cmd, cwd, "claude")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // claude devuelve el JSON estructurado de error (404 modelo, throttling, etc.)
    // por stdout aún con exit ≠ 0. Intentamos parsear primero — `parse_claude_json`
    // ya distingue `is_error: true` y lo surfacea en `AgentResult.error` con el
    // texto humano del campo `result`. Sólo caemos al stderr si el stdout no es
    // JSON parseable.
    if !stdout.trim().is_empty() {
        let parsed = parse_claude_json(&stdout)?;
        if !parsed.text.is_empty() || parsed.error.is_some() {
            return Ok(parsed);
        }
    }

    if !output.status.success() {
        return Ok(AgentResult::empty_with_error(format!(
            "claude exit {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    parse_claude_json(&stdout)
}

fn parse_claude_json(raw: &str) -> Result<AgentResult, String> {
    let value: serde_json::Value = match serde_json::from_str(raw.trim()) {
        Ok(v) => v,
        Err(e) => {
            return Ok(AgentResult::empty_with_error(format!(
                "claude JSON malformado: {e}"
            )));
        }
    };

    let text = value
        .get("result")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let session_id = value
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let cost_usd = value
        .get("total_cost_usd")
        .and_then(|v| v.as_f64())
        .or_else(|| value.get("cost_usd").and_then(|v| v.as_f64()));

    let usage = value.get("usage");
    let tokens_in = usage
        .and_then(|u| u.get("input_tokens"))
        .and_then(|v| v.as_u64());
    let tokens_out = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(|v| v.as_u64());

    let is_error = value
        .get("is_error")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // claude usa `result` para el mensaje humano del error (ej. "There's an
    // issue with the selected model (xxx)..."). Si está vacío, fallback a
    // `api_error_status`. Si tampoco, mensaje genérico.
    let error = if is_error {
        let detail = if !text.is_empty() {
            text.clone()
        } else if let Some(status) = value.get("api_error_status").and_then(|v| v.as_u64()) {
            format!("claude api error {status}")
        } else {
            "claude marcó is_error=true".to_string()
        };
        Some(detail)
    } else {
        None
    };

    Ok(AgentResult {
        text,
        tokens_in,
        tokens_out,
        cost_usd,
        session_id,
        error,
    })
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

/// Invoca `codex exec --model <model> --json --output-last-message <tmpfile> <input>`.
///
/// `codex` con `--output-last-message` escribe el último mensaje del agente al
/// archivo dado (text plano). Con `--json` además emite eventos JSONL a stdout
/// donde podemos buscar usage/cost. Combinamos ambos: texto desde el archivo,
/// tokens/costo desde el JSONL.
fn invoke_codex(
    model: &str,
    cwd: &str,
    system_prompt_path: Option<&str>,
    user_input: &str,
    session_id: Option<&str>,
) -> Result<AgentResult, String> {
    // Archivo temporal para el último mensaje. Lo abrimos en el scope del run
    // así se borra solo al finalizar (RAII de tempfile::NamedTempFile).
    let tmp = tempfile::Builder::new()
        .prefix("loop-codex-last-")
        .suffix(".txt")
        .tempfile()
        .map_err(|e| format!("no pude crear tempfile para codex: {e}"))?;
    let tmp_path: PathBuf = tmp.path().to_path_buf();

    // codex no tiene un flag dedicado para system prompt en modo exec one-shot;
    // se concatena al input. En modo resume la sesión ya tiene el system prompt
    // del primer turno, así que NO lo re-concatenamos.
    let full_input = if session_id.is_some() {
        user_input.to_string()
    } else {
        let mut s = String::new();
        if let Some(path) = system_prompt_path {
            let content = std::fs::read_to_string(path)
                .map_err(|e| format!("no pude leer system prompt: {e}"))?;
            s.push_str(&content);
            s.push_str("\n\n---\n\n");
        }
        s.push_str(user_input);
        s
    };

    let mut cmd = Command::new("codex");
    cmd.arg("exec");
    if let Some(sid) = session_id {
        // `codex exec resume [OPTIONS] <SESSION_ID> <PROMPT>` — subcommand.
        cmd.arg("resume")
            .arg("--model")
            .arg(model)
            .arg("--json")
            .arg("--output-last-message")
            .arg(&tmp_path)
            .arg(sid)
            .arg(&full_input);
    } else {
        cmd.arg("--model")
            .arg(model)
            .arg("--json")
            .arg("--output-last-message")
            .arg(&tmp_path)
            .arg(&full_input);
    }

    let output = run_command(cmd, cwd, "codex")?;

    if !output.status.success() {
        return Ok(AgentResult::empty_with_error(format!(
            "codex exit {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let last_message = std::fs::read_to_string(&tmp_path).unwrap_or_default();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    parse_codex_jsonl(&stdout, &last_message)
}

fn parse_codex_jsonl(stdout: &str, last_message: &str) -> Result<AgentResult, String> {
    // codex --json emite una secuencia de objetos JSON (JSONL). Recorremos
    // intentando capturar el último que tenga usage. Tolerantes a líneas
    // vacías o no-JSON (logs misc).
    let mut tokens_in: Option<u64> = None;
    let mut tokens_out: Option<u64> = None;
    let mut cost_usd: Option<f64> = None;
    let mut session_id: Option<String> = None;

    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };

        if let Some(sid) = value
            .get("session_id")
            .or_else(|| value.pointer("/msg/session_id"))
            .and_then(|v| v.as_str())
        {
            session_id = Some(sid.to_string());
        }

        // codex reporta usage en objetos `token_count` o similar; cubrimos
        // varias rutas razonables sin acoplarnos a una versión exacta.
        let usage = value
            .get("usage")
            .or_else(|| value.pointer("/msg/usage"))
            .or_else(|| value.pointer("/info/usage"));
        if let Some(u) = usage {
            if let Some(v) = u.get("input_tokens").and_then(|v| v.as_u64()) {
                tokens_in = Some(v);
            }
            if let Some(v) = u.get("output_tokens").and_then(|v| v.as_u64()) {
                tokens_out = Some(v);
            }
        }

        if let Some(c) = value
            .get("total_cost_usd")
            .or_else(|| value.pointer("/msg/total_cost_usd"))
            .or_else(|| value.get("cost_usd"))
            .and_then(|v| v.as_f64())
        {
            cost_usd = Some(c);
        }
    }

    Ok(AgentResult {
        text: last_message.trim_end().to_string(),
        tokens_in,
        tokens_out,
        cost_usd,
        session_id,
        error: None,
    })
}

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

/// Invoca `opencode run --format json --model <model> <input>`.
///
/// `opencode run --format json` emite un stream JSONL de eventos. Extraemos el
/// último mensaje del agente y, si está disponible, el usage/costo del evento
/// final. Si la matriz de events cambia, lo tolerable: el extractor sólo
/// asume que hay un evento con `role == "assistant"` o `type == "message"`
/// llevando el texto final.
fn invoke_opencode(
    model: &str,
    cwd: &str,
    system_prompt_path: Option<&str>,
    user_input: &str,
    session_id: Option<&str>,
) -> Result<AgentResult, String> {
    // En modo resume la sesión ya tiene el system prompt del primer turno.
    let full_input = if session_id.is_some() {
        user_input.to_string()
    } else {
        let mut s = String::new();
        if let Some(path) = system_prompt_path {
            let content = std::fs::read_to_string(path)
                .map_err(|e| format!("no pude leer system prompt: {e}"))?;
            s.push_str(&content);
            s.push_str("\n\n---\n\n");
        }
        s.push_str(user_input);
        s
    };

    let mut cmd = Command::new("opencode");
    cmd.arg("run")
        .arg("--format")
        .arg("json")
        .arg("--model")
        .arg(model);
    if let Some(sid) = session_id {
        cmd.arg("--session").arg(sid);
    }
    cmd.arg(&full_input);

    let output = run_command(cmd, cwd, "opencode")?;

    if !output.status.success() {
        return Ok(AgentResult::empty_with_error(format!(
            "opencode exit {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_opencode_stream(&stdout)
}

fn parse_opencode_stream(raw: &str) -> Result<AgentResult, String> {
    let mut last_text: Option<String> = None;
    let mut tokens_in: Option<u64> = None;
    let mut tokens_out: Option<u64> = None;
    let mut cost_usd: Option<f64> = None;
    let mut session_id: Option<String> = None;
    let mut saw_any = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        saw_any = true;

        // El último mensaje del assistant es el output del agente. La shape
        // exacta varía por versión: intentamos `role=assistant` con `content`
        // string o array de partes con `text`.
        let role = value
            .get("role")
            .or_else(|| value.pointer("/message/role"))
            .and_then(|v| v.as_str());
        if matches!(role, Some("assistant")) {
            if let Some(text) = extract_opencode_text(&value) {
                last_text = Some(text);
            }
        }

        if let Some(sid) = value
            .get("session_id")
            .or_else(|| value.pointer("/session/id"))
            .and_then(|v| v.as_str())
        {
            session_id = Some(sid.to_string());
        }

        let usage = value
            .get("usage")
            .or_else(|| value.pointer("/message/usage"));
        if let Some(u) = usage {
            if let Some(v) = u.get("input_tokens").and_then(|v| v.as_u64()) {
                tokens_in = Some(v);
            }
            if let Some(v) = u.get("output_tokens").and_then(|v| v.as_u64()) {
                tokens_out = Some(v);
            }
        }

        if let Some(c) = value
            .get("cost_usd")
            .or_else(|| value.get("total_cost_usd"))
            .and_then(|v| v.as_f64())
        {
            cost_usd = Some(c);
        }
    }

    if !saw_any {
        // No fue JSONL — opencode pudo haber emitido texto plano (fallback).
        // Tratamos todo el stdout como el mensaje del agente.
        return Ok(AgentResult {
            text: raw.trim().to_string(),
            tokens_in: None,
            tokens_out: None,
            cost_usd: None,
            session_id: None,
            error: None,
        });
    }

    Ok(AgentResult {
        text: last_text.unwrap_or_default(),
        tokens_in,
        tokens_out,
        cost_usd,
        session_id,
        error: None,
    })
}

fn extract_opencode_text(value: &serde_json::Value) -> Option<String> {
    let content = value
        .get("content")
        .or_else(|| value.pointer("/message/content"))?;

    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }

    if let Some(arr) = content.as_array() {
        let mut buf = String::new();
        for part in arr {
            if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                buf.push_str(t);
            } else if let Some(t) = part.as_str() {
                buf.push_str(t);
            }
        }
        if !buf.is_empty() {
            return Some(buf);
        }
    }

    None
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Ejecuta `cmd` en `cwd` capturando stdout/stderr. Mapea "binario no
/// encontrado" (`ErrorKind::NotFound`) a un error legible que el frontend usa
/// para sugerirle al usuario instalar el CLI.
fn run_command(
    mut cmd: Command,
    cwd: &str,
    cli_name: &str,
) -> Result<std::process::Output, String> {
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let started_at = std::time::Instant::now();
    let result = cmd.output();
    let elapsed_ms = started_at.elapsed().as_millis();

    // Section 10.5 — log opcional de la invocación. Lo escribimos en append a
    // un archivo en el sistema temp para debugging post-mortem (no nos
    // arriesgamos a tocar el config dir desde un spawn_blocking, así que
    // usamos `std::env::temp_dir`). Fallar acá no debe romper la ejecución
    // del CLI — todos los errores de IO del logger se ignoran.
    log_cli_invocation(cli_name, cwd, elapsed_ms, &result);

    result.map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!(
            "CLI '{cli_name}' no encontrado en PATH. Instalalo y reabrí la app."
        ),
        _ => format!("error invocando {cli_name}: {e}"),
    })
}

/// Path al log de invocaciones del CLI. Vive en `<temp>/polakapi-loop-cli.log`
/// para mantenerlo predecible y sin requerir el AppHandle del comando Tauri
/// (que complicaría pasar el handle a `spawn_blocking`).
fn cli_log_path() -> PathBuf {
    std::env::temp_dir().join("polakapi-loop-cli.log")
}

/// Append de una línea al log de invocaciones. Soft-fail: cualquier error de
/// IO se ignora — el logger es auxiliar y no debe romper el flow del run.
fn log_cli_invocation(
    cli_name: &str,
    cwd: &str,
    elapsed_ms: u128,
    result: &std::io::Result<std::process::Output>,
) {
    let path = cli_log_path();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let line = match result {
        Ok(out) => format!(
            "[{now}] cli={cli_name} cwd={cwd} elapsed_ms={elapsed_ms} exit={} stdout_bytes={} stderr_bytes={}\n",
            out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".to_string()),
            out.stdout.len(),
            out.stderr.len(),
        ),
        Err(e) => format!(
            "[{now}] cli={cli_name} cwd={cwd} elapsed_ms={elapsed_ms} error={e}\n"
        ),
    };

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_full_payload() {
        let raw = r#"{
            "result": "hola mundo",
            "session_id": "abc-123",
            "total_cost_usd": 0.0042,
            "usage": { "input_tokens": 12, "output_tokens": 5 },
            "is_error": false
        }"#;
        let parsed = parse_claude_json(raw).unwrap();
        assert_eq!(parsed.text, "hola mundo");
        assert_eq!(parsed.session_id.as_deref(), Some("abc-123"));
        assert_eq!(parsed.tokens_in, Some(12));
        assert_eq!(parsed.tokens_out, Some(5));
        assert!(parsed.cost_usd.unwrap() > 0.0);
        assert!(parsed.error.is_none());
    }

    #[test]
    fn parses_claude_with_is_error_true() {
        let raw = r#"{ "result": "fallo", "is_error": true }"#;
        let parsed = parse_claude_json(raw).unwrap();
        assert_eq!(parsed.text, "fallo");
        assert!(parsed.error.is_some());
    }

    #[test]
    fn claude_malformed_json_becomes_error() {
        let parsed = parse_claude_json("not json").unwrap();
        assert!(parsed.error.is_some());
        assert!(parsed.text.is_empty());
    }

    #[test]
    fn parses_codex_jsonl_extracts_usage_and_last_message() {
        let jsonl = "{\"msg\":{\"session_id\":\"sx\"}}\n{\"usage\":{\"input_tokens\":7,\"output_tokens\":3}}\n";
        let parsed = parse_codex_jsonl(jsonl, "respuesta final").unwrap();
        assert_eq!(parsed.text, "respuesta final");
        assert_eq!(parsed.tokens_in, Some(7));
        assert_eq!(parsed.tokens_out, Some(3));
        assert_eq!(parsed.session_id.as_deref(), Some("sx"));
    }

    #[test]
    fn parses_opencode_stream_with_assistant_message() {
        let stream = r#"{"role":"user","content":"hi"}
{"role":"assistant","content":"hola desde opencode","usage":{"input_tokens":4,"output_tokens":6}}
"#;
        let parsed = parse_opencode_stream(stream).unwrap();
        assert_eq!(parsed.text, "hola desde opencode");
        assert_eq!(parsed.tokens_in, Some(4));
        assert_eq!(parsed.tokens_out, Some(6));
    }

    #[test]
    fn opencode_assistant_with_content_parts() {
        let stream = r#"{"role":"assistant","content":[{"text":"parte uno "},{"text":"parte dos"}]}
"#;
        let parsed = parse_opencode_stream(stream).unwrap();
        assert_eq!(parsed.text, "parte uno parte dos");
    }

    #[test]
    fn opencode_non_jsonl_fallbacks_to_plain_text() {
        let parsed = parse_opencode_stream("solo texto plano\n").unwrap();
        assert_eq!(parsed.text, "solo texto plano");
    }
}
