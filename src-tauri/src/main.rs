// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The Tauri app binary also exposes a `capture` subcommand that hooks can
// invoke to record an event into `polakapi.db`. Dispatch is by first arg:
//   - `capture`        -> polakapi-capture helper
//   - anything else    -> normal Tauri app startup
// This keeps a single binary (matches Tauri's build model) and lets the
// helper reuse the `db` module compiled into the same crate.

fn main() {
    let args_os: Vec<std::ffi::OsString> = std::env::args_os().collect();
    #[cfg(target_os = "windows")]
    if let Some(code) = polakapi_lib::run_windows_process_supervisor(&args_os[1..]) {
        std::process::exit(code);
    }
    #[cfg(target_os = "windows")]
    if let Some(code) = polakapi_lib::run_windows_batch_proxy(&args_os[1..]) {
        std::process::exit(code);
    }
    let args: Vec<String> = args_os
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    if args.len() >= 2 && args[1] == "capture" {
        std::process::exit(polakapi_lib::capture::run());
    }
    if args.len() >= 3 && args[1] == "install-hooks" {
        match polakapi_lib::db::install_hooks_for_cli(&args[2]) {
            Ok(r) => {
                println!(
                    "{} hooks: {}{}",
                    r.cli,
                    if r.already_installed {
                        "already installed — "
                    } else {
                        ""
                    },
                    r.message
                );
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("install-hooks: {e}");
                std::process::exit(1);
            }
        }
    }
    polakapi_lib::run()
}
