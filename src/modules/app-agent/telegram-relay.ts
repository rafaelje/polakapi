import { invoke } from "../../shared/tauri/invoke";
import { ptyWrite } from "../terminal/pty-client";
import type { AgentEvent } from "../settings/agent-notifier";

// Agent notifications mirrored to the Telegram bot, and the answers to
// permission prompts that come back from it. The Rust side decides whether
// forwarding and approvals are on; this module reads the pane and types the
// answer, after checking the prompt is still on screen.

export type PermissionChoice = "allow" | "always" | "deny";

export interface PermissionPane {
  readScreen(maxLines?: number): string;
}

export interface PaneLookup {
  findPane(ptyId: string): PermissionPane | null;
}

const QUESTION = /Do you want to /;
const BOX_EDGES = /^[\s│┃|╭╮╰╯─━╌]+|[\s│┃|╭╮╰╯─━╌]+$/g;
const CONTEXT_LINES = 12;
const PROMPT_ATTEMPTS = 5;
const PROMPT_RETRY_MS = 400;

function basePtyId(ptyId: string): string {
  return ptyId.split(":subagent:")[0];
}

/** The permission question Claude Code shows, with the lines that explain it. */
export function findPermissionPrompt(screen: string): string | null {
  const lines = screen.split("\n");
  let question = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (QUESTION.test(lines[i])) {
      question = i;
      break;
    }
  }
  if (question < 0) return null;
  const options = lines.slice(question + 1, question + 6);
  if (!options.some((line) => /\b1\.\s*Yes\b/.test(line))) return null;
  const block = lines
    .slice(Math.max(0, question - CONTEXT_LINES), question + 1 + options.length)
    .map((line) => line.replace(BOX_EDGES, ""));
  while (block.length > 0 && block[0].trim() === "") block.shift();
  while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();
  return block.join("\n");
}

/** Keys for Claude Code's prompt: options are picked by number, Esc declines. */
export function permissionKeys(prompt: string, choice: PermissionChoice): string {
  if (choice === "deny") return "\x1b";
  if (choice === "allow") return "1";
  if (!/\b2\.\s*Yes\b/.test(prompt)) {
    throw new Error("this prompt has no option to stop asking; use Allow instead");
  }
  return "2";
}

export async function respondToPermission(
  lookup: PaneLookup,
  ptyId: string,
  choice: PermissionChoice,
): Promise<{ answered: PermissionChoice }> {
  const id = basePtyId(ptyId);
  const pane = lookup.findPane(id);
  if (!pane) throw new Error("that terminal is gone");
  const prompt = findPermissionPrompt(pane.readScreen(60));
  if (!prompt) throw new Error("the agent is no longer waiting for permission");
  await ptyWrite(id, permissionKeys(prompt, choice));
  return { answered: choice };
}

export function isPermissionChoice(value: unknown): value is PermissionChoice {
  return value === "allow" || value === "always" || value === "deny";
}

/** The prompt can be painted a moment after the hook fires, so look again briefly. */
async function waitForPrompt(lookup: PaneLookup, ptyId: string): Promise<string | null> {
  for (let attempt = 0; attempt < PROMPT_ATTEMPTS; attempt += 1) {
    const prompt = findPermissionPrompt(lookup.findPane(ptyId)?.readScreen(60) ?? "");
    if (prompt) return prompt;
    await new Promise((resolve) => setTimeout(resolve, PROMPT_RETRY_MS));
  }
  return null;
}

export async function forwardToTelegram(
  lookup: PaneLookup,
  event: AgentEvent,
  title: string,
  body: string,
): Promise<void> {
  const ptyId = basePtyId(event.ptyId);
  const prompt = event.kind === "permission" ? await waitForPrompt(lookup, ptyId) : null;
  try {
    await invoke(
      "telegram_notify",
      { notice: { kind: event.kind, title, body, ptyId, prompt } },
      { toastOnError: false },
    );
  } catch (error) {
    console.warn("Telegram notification failed", error);
  }
}
