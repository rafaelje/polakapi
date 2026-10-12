import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { TerminalPane } from "./terminal-pane";
import type { PaneSnapshot } from "./types";

const pty = vi.hoisted(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  return {
    attach: vi.fn<() => Promise<{ data: string; offset: number }>>(),
    resize: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("./pty-client", () => ({
  ptyAttach: pty.attach,
  ptyResize: pty.resize,
  ptyWrite: pty.write,
  ptyKill: pty.kill,
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    activate() {}
    dispose() {}
    fit() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    activate() {}
    dispose() {}
  },
}));

const panes: TerminalPane[] = [];
function pane(): TerminalPane {
  const result = new TerminalPane();
  result.ptyId = "handoff";
  panes.push(result);
  return result;
}
function term(pane: TerminalPane): Terminal {
  return (pane as unknown as { term: Terminal }).term;
}
function flush(pane: TerminalPane): Promise<void> {
  return new Promise((resolve) => term(pane).write("", resolve));
}
function catchUp(pane: TerminalPane, snapshot?: PaneSnapshot): Promise<void> {
  return (pane as unknown as { catchUp(snapshot?: PaneSnapshot): Promise<void> }).catchUp(snapshot);
}
function text(pane: TerminalPane): string {
  const buffer = term(pane).buffer.active;
  return Array.from(
    { length: buffer.length },
    (_, y) => buffer.getLine(y)?.translateToString(true) ?? "",
  )
    .join("\n")
    .trim();
}
afterEach(async () => {
  await Promise.all(panes.splice(0).map((pane) => pane.dispose({ keepPty: true })));
  vi.resetAllMocks();
  pty.resize.mockResolvedValue(undefined);
});

describe("TerminalPane streaming handoff with real xterm", () => {
  it("does not forward resize events from an adopted exited pane", async () => {
    const adopted = pane();
    vi.spyOn(term(adopted), "open").mockImplementation(() => {});
    await adopted.attach(document.createElement("div"), {
      existingPtyId: "handoff",
      snapshot: { screen: "final", offset: 5, cols: 80, rows: 24, exited: true },
    });
    term(adopted).resize(100, 30);
    expect(pty.resize).not.toHaveBeenCalled();
  });

  it("does not forward custom keybindings from an adopted exited pane", async () => {
    const adopted = pane();
    vi.spyOn(term(adopted), "open").mockImplementation(() => {
      (term(adopted) as unknown as { _core: { element: HTMLElement } })._core.element =
        document.createElement("div");
    });
    await adopted.attach(document.createElement("div"), {
      existingPtyId: "handoff",
      snapshot: { screen: "final", offset: 5, cols: 80, rows: 24, exited: true },
    });
    term(adopted).element!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }),
    );
    expect(pty.write).not.toHaveBeenCalled();
  });

  it("does not forward pasted input from an adopted exited pane", async () => {
    const adopted = pane();
    vi.spyOn(term(adopted), "open").mockImplementation(() => {
      (term(adopted) as unknown as { _core: { textarea: HTMLTextAreaElement } })._core.textarea =
        document.createElement("textarea");
    });
    await adopted.attach(document.createElement("div"), {
      existingPtyId: "handoff",
      snapshot: { screen: "final output", offset: 12, cols: 80, rows: 24, exited: true },
    });
    term(adopted).paste("ignored");
    expect(pty.write).not.toHaveBeenCalled();
  });

  it("retains the snapshot if an observed exit makes attachment reject", async () => {
    const source = pane();
    source.write("saved output", 12);
    const snapshot = await source.snapshot();
    const adopted = pane();
    let reject!: (error: Error) => void;
    pty.attach.mockImplementationOnce(
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        }),
    );
    const attached = catchUp(adopted, snapshot!);
    adopted.write(" final", 18);
    adopted.markExited();
    reject(new Error("PTY not found"));
    await attached;
    await flush(adopted);
    expect(text(adopted)).toBe("saved output final\n[process exited]");
    expect(adopted.isExited).toBe(true);
  });

  it("appends the exit marker after catch-up output when the PTY exits during attach", async () => {
    const adopted = pane();
    let resolve!: (value: { data: string; offset: number }) => void;
    pty.attach.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const attached = catchUp(adopted);
    adopted.write("world", 11);
    adopted.markExited();
    resolve({ data: "hello ", offset: 6 });
    await attached;
    await flush(adopted);
    expect(text(adopted)).toBe("hello world\n[process exited]");
    expect(pty.resize).not.toHaveBeenCalled();
  });

  it("does not resize an exited PTY when its pane is fitted", () => {
    const source = pane();
    source.markExited();
    source.fit();
    expect(source.isExited).toBe(true);
    expect(pty.resize).not.toHaveBeenCalled();
  });

  it("restores the final screen without attaching an exited PTY", async () => {
    const source = pane();
    source.write("final output", 12);
    source.markExited();
    const snapshot = await source.snapshot();
    const adopted = pane();
    pty.attach.mockRejectedValueOnce(new Error("PTY not found"));
    await catchUp(adopted, snapshot!);
    await flush(adopted);
    expect(text(adopted)).toBe(text(source));
    expect(text(adopted)).toContain("final output");
    expect(text(adopted)).toContain("[process exited]");
    expect(pty.attach).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();
    expect((await adopted.snapshot())?.exited).toBe(true);
  });

  it.each([
    ["CSI", "\x1b[31", "mTAIL"],
    ["OSC", "\x1b]0;title", "\x07TAIL"],
    ["DCS", "\x1bP$q", "m\x1b\\TAIL"],
    ["ESC charset", "\x1b(", "BTAIL"],
  ])(
    "continues incomplete %s after a previously serialized checkpoint",
    async (_name, prefix, suffix) => {
      const source = pane();
      source.write("PREFIX", 6);
      await source.snapshot();
      const offset = 6 + new TextEncoder().encode(prefix).length;
      source.write(prefix, offset);
      const snapshot = await source.snapshot();
      const adopted = pane();
      pty.attach.mockResolvedValueOnce({
        data: suffix,
        offset: offset + new TextEncoder().encode(suffix).length,
      });
      await catchUp(adopted, snapshot!);
      source.write(suffix);
      await Promise.all([flush(source), flush(adopted)]);
      expect(text(adopted)).toBe(text(source));
      expect(text(adopted)).toBe("PREFIXTAIL");
      expect((await adopted.snapshot())?.replay).toBeUndefined();
    },
  );

  it("preserves an incomplete SGR sequence across snapshots", async () => {
    const source = pane();
    source.write("\x1b[31", 4);
    const snapshot = await source.snapshot();
    const adopted = pane();
    pty.attach.mockResolvedValueOnce({ data: "mRED", offset: 8 });
    await catchUp(adopted, snapshot!);
    await flush(adopted);
    expect(text(adopted)).toBe("RED");
    const cell = term(adopted).buffer.active.getLine(0)!.getCell(0)!;
    expect(cell.isFgPalette()).toBeTruthy();
    expect(cell.getFgColor()).toBe(1);
  });

  it("trims only the overlapping UTF-8 prefix of live output", async () => {
    const adopted = pane();
    let resolve!: (value: { data: string; offset: number }) => void;
    pty.attach.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const attached = catchUp(adopted);
    adopted.write("é世界!", 9);
    resolve({ data: "é世", offset: 5 });
    await attached;
    await flush(adopted);
    expect(text(adopted)).toBe("é世界!");
  });

  it("replays older output before live output buffered during attach", async () => {
    const adopted = pane();
    let resolve!: (value: { data: string; offset: number }) => void;
    pty.attach.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const attached = catchUp(adopted);
    adopted.write("world", 11);
    resolve({ data: "hello ", offset: 6 });
    await attached;
    await flush(adopted);
    expect(text(adopted)).toBe("hello world");
  });
});
