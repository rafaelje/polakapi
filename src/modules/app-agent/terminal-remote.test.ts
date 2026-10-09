import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  writes: [] as Array<[string, string]>,
  onWrite: (_data: string): void => {},
}));
vi.mock("../terminal/pty-client", () => ({
  ptyWrite: (id: string, data: string) => {
    mocked.writes.push([id, data]);
    mocked.onWrite(data);
    return Promise.resolve();
  },
}));
vi.mock("../../shared/tauri/invoke", () => ({ invoke: () => Promise.resolve([]) }));

import { runInTerminal, type RemotePane } from "./terminal-remote";

/** A pane whose screen is a list of rows; the test scripts what a command prints. */
class FakePane implements RemotePane {
  rows = ["user@host:~/p$ "];
  finishedCommands: number;
  private listeners = new Set<(code: number) => void>();

  constructor(integrated: boolean) {
    this.finishedCommands = integrated ? 1 : 0;
  }
  onCommandDone(listener: (code: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  cursorRow(): number {
    return this.rows.length - 1;
  }
  readFrom(row: number): string {
    return this.rows.slice(row).join("\n");
  }
  finish(code: number): void {
    this.finishedCommands += 1;
    for (const listener of this.listeners) listener(code);
  }
}

beforeEach(() => {
  mocked.writes.length = 0;
  vi.useFakeTimers();
});

describe("runInTerminal", () => {
  it("types the command and returns what it printed once the shell says it is done", async () => {
    const pane = new FakePane(true);
    mocked.onWrite = (data) => {
      pane.rows[0] += data.trim();
      pane.rows.push("On branch main", "nothing to commit", "user@host:~/p$ ");
      setTimeout(() => pane.finish(0), 300);
    };
    const run = runInTerminal(pane, "pty-1", "git status");
    await vi.advanceTimersByTimeAsync(600);
    const result = await run;
    expect(mocked.writes).toEqual([["pty-1", "git status\r"]]);
    expect(result).toEqual({
      exitCode: 0,
      finished: true,
      needsPassword: false,
      transcript: "$ git status\nOn branch main\nnothing to commit",
    });
  });

  it("reports a failing exit code", async () => {
    const pane = new FakePane(true);
    mocked.onWrite = () => {
      pane.rows.push("fatal: not a git repository", "user@host:~/p$ ");
      setTimeout(() => pane.finish(128), 100);
    };
    const run = runInTerminal(pane, "pty-1", "git log");
    await vi.advanceTimersByTimeAsync(400);
    expect((await run).transcript).toBe("$ git log\nfatal: not a git repository\n[exit 128]");
  });

  it("stops at a password prompt without answering it", async () => {
    const pane = new FakePane(true);
    mocked.onWrite = () => {
      pane.rows.push("[sudo] password for miguel: ");
    };
    const run = runInTerminal(pane, "pty-1", "sudo ls");
    await vi.advanceTimersByTimeAsync(600);
    const result = await run;
    expect(result.needsPassword).toBe(true);
    expect(result.transcript).toContain("[waiting for a password — type it at the computer]");
    expect(mocked.writes).toHaveLength(1);
  });

  it("falls back to quiet output without shell integration", async () => {
    const pane = new FakePane(false);
    mocked.onWrite = () => {
      pane.rows.push("a.txt  b.txt", "$ ");
    };
    const run = runInTerminal(pane, "pty-1", "ls");
    await vi.advanceTimersByTimeAsync(2500);
    const result = await run;
    expect(result.finished).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.transcript).toBe("$ ls\na.txt  b.txt");
  });

  it("says when a command is still running", async () => {
    const pane = new FakePane(true);
    mocked.onWrite = () => {
      pane.rows.push("Listening on :3000");
    };
    const run = runInTerminal(pane, "pty-1", "npm run dev", 1000);
    await vi.advanceTimersByTimeAsync(1500);
    expect((await run).transcript).toBe(
      "$ npm run dev\nListening on :3000\n[still running — /peek shows more later]",
    );
  });

  it("refuses empty and multi-line input", async () => {
    const pane = new FakePane(true);
    await expect(runInTerminal(pane, "pty-1", "  ")).rejects.toThrow(/empty/);
    await expect(runInTerminal(pane, "pty-1", "ls\nrm -rf x")).rejects.toThrow(/one command/);
    expect(mocked.writes).toHaveLength(0);
  });
});
