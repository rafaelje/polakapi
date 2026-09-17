use std::path::PathBuf;

use crate::ctx::config;
use crate::ctx::session::CtxSession;

// `polakapi ctx …` — the same tools the MCP server exposes, reachable through
// any agent's ordinary shell tool.
//
// MCP buys schema discovery and avoids shell quoting, but it has to be
// registered per CLI. This surface needs no registration at all, works with
// every CLI that can run a command, and lets the user inspect the store by
// hand. Both talk to the same store.

const USAGE: &str = "\
polakapi ctx — keep large tool output out of the agent's context

  polakapi ctx exec [--source <label>] <command…>
                                    run a command, store its output, print a summary or pointer
  polakapi ctx search <query>       search this session's offloaded output
        [--source <label>] [--limit <n>]
  polakapi ctx read <source> <n>    print one section verbatim
  polakapi ctx list                 what this session offloaded, and how much it saved

Scoped to $POLAKAPI_PTY_ID, the terminal polakapi spawned the agent in.";

pub fn run(args: &[String]) -> i32 {
    // `exec` answers with the wrapped command's own exit status, so an agent
    // whose command was routed through here still sees a failure as a failure.
    if args.first().map(String::as_str) == Some("exec") {
        return match exec(&args[1..]) {
            Ok((text, code)) => {
                println!("{text}");
                code
            }
            Err(message) => {
                eprintln!("polakapi ctx: {message}");
                1
            }
        };
    }
    match dispatch(args) {
        Ok(output) => {
            println!("{output}");
            0
        }
        Err(message) => {
            eprintln!("polakapi ctx: {message}");
            1
        }
    }
}

fn dispatch(args: &[String]) -> Result<String, String> {
    let Some(command) = args.first().map(String::as_str) else {
        return Ok(USAGE.to_string());
    };
    match command {
        "help" | "--help" | "-h" => Ok(USAGE.to_string()),
        "exec" => exec(&args[1..]).map(|(text, _)| text),
        "search" => search(&args[1..]),
        "read" => read(&args[1..]),
        "list" => list(),
        other => Err(format!("unknown subcommand {other:?}\n\n{USAGE}")),
    }
}

fn open() -> Result<CtxSession, String> {
    let session_id = crate::ctx::paths::session_key_from_env().ok_or_else(|| {
        "POLAKAPI_PTY_ID is not set — run this inside a polakapi terminal".to_string()
    })?;
    let project: Option<PathBuf> = std::env::current_dir().ok();
    CtxSession::open(&session_id, project.as_deref(), config::load_from_env())
}

fn exec(args: &[String]) -> Result<(String, i32), String> {
    let (source, args) = match args {
        [flag, label, rest @ ..] if flag == "--source" => (Some(label.clone()), rest),
        _ => (None, args),
    };
    if args.is_empty() {
        return Err("exec needs a command".into());
    }
    let command = args.join(" ");
    let output = crate::ctx::mcp::run_shell(&command, std::env::current_dir().ok().as_deref())?;
    let source =
        source.unwrap_or_else(|| format!("exec:{}", crate::ctx::mcp::source_slug(&command)));
    let context = open()?.offload(&source, &output.text)?.context_text;
    let code = output.code.unwrap_or(1);
    Ok((crate::ctx::mcp::with_status(context, &output), code))
}

fn search(args: &[String]) -> Result<String, String> {
    let mut query = Vec::new();
    let mut source: Option<String> = None;
    let mut limit = 8usize;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--source" => {
                source = args.get(index + 1).cloned();
                index += 2;
            }
            "--limit" => {
                limit = args
                    .get(index + 1)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(limit)
                    .clamp(1, 50);
                index += 2;
            }
            other => {
                query.push(other.to_string());
                index += 1;
            }
        }
    }
    if query.is_empty() {
        return Err("search needs a query".into());
    }
    let query = query.join(" ");
    let hits = open()?.search(&query, source.as_deref(), limit)?;
    if hits.is_empty() {
        return Ok(format!("No matches for {query:?}."));
    }
    let mut out = vec![format!(
        "{} for {query:?}:",
        if hits.len() == 1 {
            "1 match".to_string()
        } else {
            format!("{} matches", hits.len())
        }
    )];
    for hit in hits {
        out.push(format!(
            "[{} #{}] {}{}\n{}",
            hit.source,
            hit.ordinal,
            hit.heading.unwrap_or_else(|| "(untitled)".into()),
            if hit.has_code { " (code)" } else { "" },
            hit.snippet
        ));
    }
    out.push("Read one with: polakapi ctx read <source> <n>".into());
    Ok(out.join("\n\n"))
}

fn read(args: &[String]) -> Result<String, String> {
    let source = args.first().ok_or("read needs a source")?;
    let section: i64 = args
        .get(1)
        .ok_or("read needs a section number")?
        .parse()
        .map_err(|_| "section must be a number".to_string())?;
    open()?
        .read(source, section)?
        .ok_or_else(|| format!("no section {section} in {source}"))
}

fn list() -> Result<String, String> {
    let mut session = open()?;
    let sources = session.list()?;
    if sources.is_empty() {
        return Ok("Nothing offloaded in this session yet.".into());
    }
    let (raw, context) = session.savings()?;
    let mut out = vec![format!(
        "{} sources — {raw} bytes held out of context, {context} bytes returned.",
        sources.len()
    )];
    for source in sources {
        out.push(format!(
            "  {} ({}) — {} sections, {} bytes raw",
            source.source, source.kind, source.chunks, source.raw_bytes
        ));
    }
    Ok(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_arguments_prints_the_usage() {
        assert!(dispatch(&[]).unwrap().contains("polakapi ctx exec"));
        assert!(dispatch(&["help".to_string()])
            .unwrap()
            .contains("polakapi ctx search"));
    }

    #[test]
    fn an_unknown_subcommand_explains_itself() {
        let error = dispatch(&["frobnicate".to_string()]).unwrap_err();
        assert!(error.contains("unknown subcommand"));
        assert!(error.contains("polakapi ctx exec"));
    }

    #[test]
    fn subcommands_report_their_missing_arguments() {
        assert!(exec(&[]).unwrap_err().contains("needs a command"));
        assert!(search(&[]).unwrap_err().contains("needs a query"));
        assert!(read(&[]).unwrap_err().contains("needs a source"));
        assert!(read(&["src".to_string()]).unwrap_err().contains("section"));
    }

    #[test]
    fn without_a_terminal_id_it_says_so_instead_of_guessing() {
        // `open` is what every data subcommand goes through.
        temp_env_without_pty(|| {
            // `unwrap_err` would need CtxSession: Debug, which it cannot be —
            // it owns a SQLite connection.
            match open() {
                Err(error) => assert!(error.contains("POLAKAPI_PTY_ID"), "{error}"),
                Ok(_) => panic!("expected an error without POLAKAPI_PTY_ID"),
            }
        });
    }

    fn temp_env_without_pty(body: impl FnOnce()) {
        let previous = std::env::var("POLAKAPI_PTY_ID").ok();
        std::env::remove_var("POLAKAPI_PTY_ID");
        body();
        if let Some(value) = previous {
            std::env::set_var("POLAKAPI_PTY_ID", value);
        }
    }
}
