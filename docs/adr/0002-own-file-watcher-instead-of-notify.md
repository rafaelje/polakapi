# Own file watcher instead of the `notify` crate

Code review needs to know when a file in the project is written so it can refresh. The standard Rust crate for this, `notify`, is licensed CC0-1.0, which `deny.toml` does not allow: CC0 explicitly does not license patent rights, and Fedora reclassified it as not allowed for code in 2022. We respect `deny.toml` instead of adding a per-crate exception (the route Foundry takes), and write our own watcher on top of permissively licensed OS bindings: `inotify` on Linux, `fsevent-sys` on macOS and `windows-sys` on Windows.

The watcher is deliberately narrow: it only emits a coalesced "something changed" signal for one project, never per-file events, so it does not need rename tracking, file ids or event ordering. The cost is three backends to maintain, each only exercised on its own OS.
