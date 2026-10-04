// Context mode: tool output is diverted into a local store and the model gets a
// searchable pointer instead of the raw bytes. See docs/context-mode-plan.md.
//
// The pieces, in the order data flows through them:
//   router    — decide: leave it alone, summarise it, or index it
//   chunk     — split indexable text without breaking code blocks
//   summarize — compute what to say about aggregate data
//   store     — SQLite + FTS5, one row per source plus its chunks
//   paths     — where the store lives, and when it moves into the project
//   session   — one agent session's store, including promotion
//   offload   — ties the above together for one tool result
//   config    — the Context Mode settings the UI writes
//   shell     — runs a rerouted command and captures its capped output
//   mcp       — the stdio server that exposes ctx_* to every CLI
//   intercept — which agent shell commands to reroute, and the rewrite
//   hook      — `polakapi ctx-hook`, the Claude Code hook handler
//   install   — keeps the hooks in Claude's settings in step with the toggles
//   project_data — lets the user delete what a project has stored

pub mod chunk;
pub mod cli;
pub mod config;
pub mod hook;
pub mod install;
pub mod intercept;
pub mod mcp;
pub mod offload;
pub mod paths;
pub mod project_data;
pub mod router;
pub mod session;
pub mod shell;
pub mod store;
pub mod summarize;
