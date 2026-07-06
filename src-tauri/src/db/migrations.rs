//! Embedded migration scripts. Keeping them in a sibling module makes
//! `db.rs` read cleaner and lets each migration live in its own `.sql`
//! file under `src-tauri/migrations/`.

pub const M_0001_INIT: &str = include_str!("../../migrations/0001_init.sql");
