import type { ChatTurn } from "./state";

/**
 * One-shot prompt for the bootstrap call: serializes prior turns as text
 * followed by the current user message. The CLIs treat the whole payload as
 * a single user prompt; the explicit `## User` / `## Agent` headers cue the
 * model on roles. The system prompt is delivered separately via
 * `--append-system-prompt`.
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
 * Final prompt that consolidates the conversation into a structured
 * `01-problem.md`. The expected layout is inlined so the response can be
 * persisted without further parsing.
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
 * Consolidation instruction without history. Used when the CLI already has
 * the conversation loaded in session (`--resume` / `exec resume` /
 * `--session`).
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
 * Heuristic for "session invalid/expired" errors. On a match the caller
 * drops the cached session id so the next turn bootstraps with full
 * serialized history.
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
 * Lenient inverse of `serializeDraftMarkdown`: returns whatever it can
 * extract if the user edited the file by hand; empty list when nothing is
 * parseable.
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
