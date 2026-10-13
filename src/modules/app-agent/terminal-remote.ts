import { invoke } from "../../shared/tauri/invoke";
import { ptyWrite } from "../terminal/pty-client";

// Running a command inside one of the user's own terminals and reading back
// what it printed, for the Telegram bot and the operator agent. Unlike
// `polakapi_run_command`, the command runs in the live shell: its cd, its
// virtualenv, its exported variables, visible in the window.
//
// The end of a command comes from the shell integration's "command done"
// marker when the shell has it (bash and zsh panes polakapi opened), and from
// the output going quiet otherwise.

export interface RemotePane {
  readonly finishedCommands: number;
  onCommandDone(listener: (exitCode: number) => void): () => void;
  /** Resolves once everything the terminal already received is on screen. */
  settle?(): Promise<void>;
  cursorRow(): number;
  readFrom(row: number): string;
}

export interface TerminalRun {
  transcript: string;
  exitCode: number | null;
  finished: boolean;
  needsPassword: boolean;
}

export interface LivePaneInfo {
  paneId: string;
  projectId: string;
  cliId?: string;
  cwd?: string;
}

export interface TerminalInfo {
  ptyId: string;
  project: { id: string; name: string };
  cli: string;
  /** Where the shell is now, following every `cd`. */
  cwd: string;
  /** The program running in the foreground, if any. */
  busy: string | null;
}

const POLL_MS = 250;
const QUIET_MS = 1500;
export const RUN_TIMEOUT_MS = 60_000;
const PASSWORD_PROMPT =
  /(\[sudo\] password for [^:]*:|password( for [^:]+)?:|passphrase[^:]*:)\s*$/i;

/** Every live pane, in sidebar order, with its real working directory. */
export async function listTerminals(
  panes: LivePaneInfo[],
  projectOrder: Array<{ id: string; name: string }>,
): Promise<TerminalInfo[]> {
  const [running, cwds] = await Promise.all([
    invoke<Array<{ ptyId: string; command: string }>>("pty_running_commands", undefined, {
      toastOnError: false,
    }).catch(() => []),
    invoke<Array<{ ptyId: string; cwd: string }>>("pty_cwds", undefined, {
      toastOnError: false,
    }).catch(() => []),
  ]);
  const busy = new Map(running.map((row) => [row.ptyId, row.command]));
  const cwd = new Map(cwds.map((row) => [row.ptyId, row.cwd]));
  const rank = new Map(projectOrder.map((project, index) => [project.id, index]));
  return [...panes]
    .filter((pane) => rank.has(pane.projectId))
    .sort((a, b) => (rank.get(a.projectId) ?? 0) - (rank.get(b.projectId) ?? 0))
    .map((pane) => ({
      ptyId: pane.paneId,
      project: projectOrder[rank.get(pane.projectId) ?? 0],
      cli: pane.cliId ?? "shell",
      cwd: cwd.get(pane.paneId) ?? pane.cwd ?? "",
      busy: busy.get(pane.paneId) ?? null,
    }));
}

function outputLines(text: string, finished: boolean): string[] {
  const lines = text.split("\n");
  // The first row is the prompt with the command echoed after it.
  lines.shift();
  // Once the command is done the last row is the next prompt.
  if (finished && lines.length > 0) lines.pop();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

export function transcriptOf(
  command: string,
  run: Omit<TerminalRun, "transcript">,
  body: string[],
): string {
  const lines = [`$ ${command}`, ...body];
  if (run.needsPassword) lines.push("[waiting for a password — type it at the computer]");
  else if (!run.finished) lines.push("[still running — /peek shows more later]");
  else if (run.exitCode !== null && run.exitCode !== 0) lines.push(`[exit ${run.exitCode}]`);
  return lines.join("\n");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SETTLE_MS = 500;

export async function runInTerminal(
  pane: RemotePane,
  ptyId: string,
  command: string,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<TerminalRun> {
  const line = command.trim();
  if (!line) throw new Error("the command is empty");
  if (/[\r\n]/.test(line)) throw new Error("send one command line at a time");
  // A prompt still being parsed would otherwise end this run before it starts.
  if (pane.settle) await Promise.race([pane.settle(), sleep(SETTLE_MS)]);
  const integrated = pane.finishedCommands > 0;
  const start = pane.cursorRow();
  let exitCode: number | null = null;
  let done = false;
  const stop = pane.onCommandDone((code) => {
    exitCode = code;
    done = true;
  });
  try {
    await ptyWrite(ptyId, `${line}\r`);
    const started = Date.now();
    let last = "";
    let changedAt = Date.now();
    let needsPassword = false;
    while (!done && Date.now() - started < timeoutMs) {
      await sleep(POLL_MS);
      const text = pane.readFrom(start);
      if (text !== last) {
        last = text;
        changedAt = Date.now();
      }
      const tail = text.split("\n").pop() ?? "";
      if (PASSWORD_PROMPT.test(tail)) {
        needsPassword = true;
        break;
      }
      if (!integrated && text.includes("\n") && Date.now() - changedAt >= QUIET_MS) {
        done = true;
      }
    }
    const finished = done && !needsPassword;
    const run = { exitCode, finished, needsPassword };
    const body = outputLines(pane.readFrom(start), finished);
    return { ...run, transcript: transcriptOf(line, run, body) };
  } finally {
    stop();
  }
}
