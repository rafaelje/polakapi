import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { TerminalCommandOutput } from "./terminal-command-output";
import {
  attachCommandDoneCapture,
  attachShellCommandCapture,
  attachCommandOutputEndCapture,
} from "./terminal-shell-integration";

const start = (command: string): string => `\x1b]9931;test-token;c;${btoa(command)}\x07`;
const done = "\x1b]9932;test-token;0\x07";

describe("terminal command output", () => {
  const terminals: Terminal[] = [];
  afterEach(() => terminals.splice(0).forEach((term) => term.dispose()));

  function setup(cols = 20, scrollback = 5000) {
    const term = new Terminal({ cols, rows: 5, scrollback, allowProposedApi: true });
    terminals.push(term);
    const capture = new TerminalCommandOutput(term);
    attachShellCommandCapture(
      term,
      () => "test-token",
      ({ command }) => capture.start(command),
    );
    attachCommandDoneCapture(
      term,
      () => "test-token",
      () => capture.prompt(),
    );
    attachCommandOutputEndCapture(
      term,
      () => "test-token",
      () => capture.finish(),
    );
    capture.prompt();
    const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
    return { term, capture, write };
  }

  it("copies the submitted command and plain output without either prompt", async () => {
    const { capture, write } = setup();
    expect(capture.command).toBe("");
    expect(capture.output).toBeNull();
    await write(`$ printf test\r\n${start("printf test")}\x1b[31mtest\x1b[0m${done}$ `);
    expect(capture.command).toBe("printf test");
    expect(capture.output).toBe("test");
    await write("later input");
    expect(capture.output).toBe("test");
  });

  it("preserves multiline commands, Unicode, hard newlines and soft wraps", async () => {
    const { capture, write } = setup(10);
    const command = "printf 'first\\n'\nprintf 'second\\n'";
    await write(`$ command\r\n${start(command)}abcdefghijklmnop\r\nCafé 中文 😀\r\n${done}$ `);
    expect(capture.command).toBe(command);
    expect(capture.output).toBe("abcdefghijklmnop\nCafé 中文 😀\n");
  });

  it("returns running output and replaces the previous command, including empty output", async () => {
    const { capture, write } = setup();
    await write(`${start("first")}running\r\n`);
    expect(capture.output).toBe("running\n");
    await write(`${done}$ second\r\n${start("second")}${done}$ `);
    expect(capture.command).toBe("second");
    expect(capture.output).toBe("");
  });

  it("preserves spaces at soft-wrap boundaries", async () => {
    const { capture, write } = setup(10);
    await write(`${start("wrapped")}123456789 abc${done}`);
    expect(capture.output).toBe("123456789 abc");
  });

  it("copies rendered text beyond the cursor after a carriage-return update", async () => {
    const { capture, write } = setup();
    await write(`${start("printf 'hello\\rX'")}hello\rX\x1b]9933;test-token\x07`);
    expect(capture.output).toBe("Xello");
  });

  it("ends output before shell decorations and ignores another pane's boundary", async () => {
    const { capture, write } = setup();
    await write(
      `${start("printf partial")}par\x1b]9933;other-token\x07tial\x1b]9933;test-token\x07%    \r\n${done}$ `,
    );
    expect(capture.output).toBe("partial");
  });

  it("does not guess output after scrollback eviction, resize or an alternate screen", async () => {
    const { capture, term, write } = setup(10, 0);
    await write(start("long") + "line\r\n".repeat(12));
    expect(capture.output).toBeNull();
    await write(`${start("resize")}text`);
    term.resize(12, 5);
    expect(capture.output).toBeNull();
    await write(`${start("editor")}\x1b[?1049hfull screen\x1b[?1049l${done}`);
    expect(capture.command).toBe("editor");
    expect(capture.output).toBeNull();
    capture.dispose();
  });

  it("keeps partial-line output with its command when the next prompt shares the row", async () => {
    const { capture, term, write } = setup(40);
    await write(
      `$ first\r\n${start("first")}abcdefghijklmnop${done}$ second\r\n${start("second")}two\r\n${done}$ `,
    );
    expect(capture.blockAt(1, 2)?.command).toBe("first");
    expect(capture.blockAt(1, 18)?.command).toBe("second");
    term.resize(10, 5);
    expect(capture.blockAt(2, 2)).toBeUndefined();
    expect(capture.blocks.map((block) => capture.snapshot(block).command)).toEqual([
      "first",
      "second",
    ]);
  });

  it("retains independent command blocks and excludes the current empty prompt", async () => {
    const { capture, write } = setup();
    await write(
      `$ first\r\n${start("first")}one\r\n${done}$ second\r\n${start("second")}two\r\n${done}$ `,
    );
    const first = capture.blockAt(0, 0);
    const second = capture.blockAt(2, 0);
    expect(first?.command).toBe("first");
    expect(second?.command).toBe("second");
    expect(capture.snapshot(first!).output).toBe("one\n");
    expect(capture.snapshot(second!).output).toBe("two\n");
    expect(capture.blockAt(1, 2)).toBe(first);
    expect(capture.blockAt(4, 0)).toBeUndefined();
    expect(capture.blocks).toHaveLength(2);
  });

  it("tracks old blocks through scroll and reflow, then drops evicted blocks", async () => {
    const { capture, term, write } = setup(20, 10);
    await write(`$ first\r\n${start("first")}abcdefghijklmnop\r\n${done}$ `);
    const first = capture.blocks[0];
    term.resize(10, 5);
    expect(capture.snapshot(first).output).toBe("abcdefghijklmnop\n");
    expect(capture.blockAt(first.start.line, 0)).toBe(first);
    await write("\r\n".repeat(30));
    expect(capture.blocks).toHaveLength(0);
  });

  it("keeps a silent command actionable without treating the next prompt as its output", async () => {
    const { capture, write } = setup();
    await write(`$ true\r\n${start("true")}${done}$ `);
    const block = capture.blockAt(0, 0);
    expect(block?.command).toBe("true");
    expect(capture.snapshot(block!).output).toBe("");
    expect(capture.blockAt(1, 0)).toBeUndefined();
  });
});
