import type { AgentDef } from "./types";

// ESC = \x1b. A literal `[200~` prints as text — the ESC prefix is what
// tells the terminal (and the CLI reading it) that this is a paste marker,
// so multi-line content lands as one block instead of one submitted line
// per newline.
const BRACKETED_PASTE_BEGIN = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export function composeAgentText(agent: AgentDef): string {
  if (agent.files.length === 0) return "";
  if (agent.files.length === 1) return agent.files[0].content.trim();
  return agent.files.map((f) => `<!-- ${f.title} -->\n${f.content.trim()}`).join("\n\n");
}

export function bracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_BEGIN}${text}${BRACKETED_PASTE_END}`;
}
