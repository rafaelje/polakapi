// Pure helpers for step 1 (problem intake): history serialization, prompt
// builders for the one-shot and consolidate calls, the draft markdown
// round-trip, and the session-error heuristic. Extracted from step1-chat.ts
// so they can be reasoned about and tested independently of the DOM/IO shell.

import type { ChatTurn } from "../step1-chat";

/**
 * Builds the one-shot prompt sent to the CLI on each turn. Includes prior
 * turns as textual history, in order, with the current user message at the
 * end. The system prompt (with the "intake" mode instructions) is passed by
 * `run_loop_agent` via `--append-system-prompt`.
 *
 * Format is designed to be easy to read as a single string — the CLIs don't
 * need ChatML structure; they treat everything as a user prompt and generate
 * the agent's response. The explicit headers help the model understand the
 * role of each block.
 */
export function buildHistoryPrompt(history: ChatTurn[], currentUser: string): string {
  const parts: string[] = [];
  if (history.length > 0) {
    parts.push("# Prior conversation\n");
    for (const turn of history) {
      parts.push(`## User\n${turn.user.trim()}\n`);
      const assistant = turn.assistant.trim();
      if (assistant) parts.push(`## Agent\n${assistant}\n`);
    }
  }
  parts.push("# Current user message\n");
  parts.push(currentUser.trim());
  parts.push(
    "\n\nReply to the user, continuing the conversation. Don't repeat the history; reply only to the current message.",
  );
  return parts.join("\n");
}

/**
 * Final prompt to consolidate the problem into a structured `01-problem.md`.
 * Explicitly asks for the expected format so the output is directly
 * persistable without further parsing.
 */
export function buildConsolidatePrompt(history: ChatTurn[]): string {
  const parts: string[] = [];
  parts.push("# Full conversation\n");
  for (const turn of history) {
    parts.push(`## User\n${turn.user.trim()}\n`);
    const assistant = turn.assistant.trim();
    if (assistant) parts.push(`## Agent\n${assistant}\n`);
  }
  parts.push("# Task\n");
  parts.push(buildConsolidateInstruction());
  return parts.join("\n");
}

/**
 * Pure consolidation instruction without the history. Used when the CLI
 * already has the conversation loaded in session (`--resume` / `exec resume`
 * / `--session`).
 */
export function buildConsolidateInstruction(): string {
  return (
    "Based on the prior conversation, produce a single Markdown document with a structured summary of the problem. Expected structure:\n\n" +
    "```\n" +
    "# Problem\n\n" +
    "## Context\n\n## Goal\n\n## Constraints\n\n## Success criteria\n\n## Known risks\n" +
    "```\n\n" +
    "Return only the final Markdown content (no code fences, no preamble). Concise, technical English, no emojis."
  );
}

/**
 * Heuristic to detect error messages that indicate an invalid or expired
 * session. In that case we clear the local session id to force a fresh
 * bootstrap (with serialized history) on the next turn.
 */
export function looksLikeSessionError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("session") &&
    (lower.includes("not found") ||
      lower.includes("expired") ||
      lower.includes("invalid") ||
      lower.includes("no encontrad") ||
      lower.includes("no existe"))
  );
}

/** Serializes the turns to a readable Markdown for `01-problem-draft.md`. */
export function serializeDraftMarkdown(turns: ChatTurn[]): string {
  const parts: string[] = ["# Problem draft (auto-save)\n"];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    parts.push(`## Turn ${i + 1}\n`);
    parts.push(`### User\n${turn.user.trim()}\n`);
    if (turn.assistant.trim()) {
      parts.push(`### Agent\n${turn.assistant.trim()}\n`);
    }
    if (turn.error) {
      parts.push(`> error: ${turn.error}\n`);
    }
  }
  return parts.join("\n");
}

/**
 * Inverse draft parser. Lenient: if the format doesn't match exactly (e.g.
 * the user edited it by hand), we return whatever we could extract. If
 * nothing is parseable, we return an empty list.
 *
 * Section 9 (resume) may replace this with a stricter schema based on
 * `state.json`; for now the simple round-trip is enough.
 */
export function parseDraftMarkdown(content: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const turnBlocks = content.split(/^## Turn \d+$/m).slice(1);
  for (const block of turnBlocks) {
    const userMatch = block.match(/### User\n([\s\S]*?)(?=\n### Agent|$)/);
    const agentMatch = block.match(/### Agent\n([\s\S]*?)(?=\n> error:|$)/);
    if (!userMatch) continue;
    const user = userMatch[1].trim();
    if (!user) continue;
    turns.push({
      user,
      assistant: agentMatch ? agentMatch[1].trim() : "",
      pending: false,
    });
  }
  return turns;
}
