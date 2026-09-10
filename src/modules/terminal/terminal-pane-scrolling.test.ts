import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TerminalPane } from "./terminal-pane";

const terminals = vi.hoisted(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  return [] as Terminal[];
});

vi.mock("@xterm/xterm", async (importOriginal) => {
  const actual = await importOriginal<{ Terminal: typeof Terminal }>();
  return {
    ...actual,
    Terminal: class extends actual.Terminal {
      constructor(options: ConstructorParameters<typeof Terminal>[0]) {
        super(options);
        terminals.push(this);
      }
    },
  };
});

const panes: TerminalPane[] = [];

function createPane(): { pane: TerminalPane; terminal: Terminal } {
  const pane = new TerminalPane();
  panes.push(pane);
  const terminal = terminals[terminals.length - 1];
  document.body.append(pane.el);
  terminal.open(pane.bodyEl);
  return { pane, terminal };
}

async function write(pane: TerminalPane, terminal: Terminal, data: string): Promise<void> {
  const parsed = new Promise<void>((resolve) => {
    const subscription = terminal.onWriteParsed(() => {
      subscription.dispose();
      resolve();
    });
  });
  pane.write(data);
  await parsed;
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index}\r\n`).join("");
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ addListener() {}, removeListener() {} }));
});

afterEach(async () => {
  await Promise.all(panes.splice(0).map((pane) => pane.dispose()));
  terminals.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TerminalPane follows the latest output", () => {
  it("returns from history after new output is parsed without input or focus", async () => {
    const { pane, terminal } = createPane();
    const onData = vi.fn();
    terminal.onData(onData);
    const focus = vi.spyOn(terminal, "focus");
    await write(pane, terminal, lines(100));
    terminal.scrollToTop();
    expect(terminal.buffer.active.viewportY).toBe(0);

    pane.write("latest message\r\n");
    expect(terminal.buffer.active.viewportY).toBe(0);
    await new Promise<void>((resolve) => {
      terminal.onWriteParsed(() => resolve());
    });

    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);
    expect(terminal.buffer.active.baseY).toBeGreaterThan(0);
    expect(onData).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("follows streaming output after the scrollback limit, including wrapped lines", async () => {
    const { pane, terminal } = createPane();
    await write(pane, terminal, lines(6000));
    expect(terminal.buffer.active.baseY).toBe(5000);

    for (let index = 0; index < 3; index++) {
      terminal.scrollToTop();
      await write(pane, terminal, "wrapped output ".repeat(100) + "\r\n");
      expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);
    }
  });

  it("keeps output and scrolling independent across panes", async () => {
    const first = createPane();
    const second = createPane();
    await write(first.pane, first.terminal, lines(100));
    await write(second.pane, second.terminal, lines(100));
    first.terminal.scrollToTop();
    second.terminal.scrollToTop();

    await write(second.pane, second.terminal, "new output\r\n");

    expect(first.terminal.buffer.active.viewportY).toBe(0);
    expect(second.terminal.buffer.active.viewportY).toBe(second.terminal.buffer.active.baseY);
  });

  it("shows the bottom after a pane is fitted without focusing it", async () => {
    const { pane, terminal } = createPane();
    await write(pane, terminal, lines(100));
    terminal.scrollToTop();
    const focus = vi.spyOn(terminal, "focus");
    vi.spyOn(FitAddon.prototype, "fit").mockImplementationOnce(() => terminal.resize(40, 12));

    pane.fit();

    expect(terminal.rows).toBe(12);
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);
    expect(focus).not.toHaveBeenCalled();
  });

  it("preserves full-screen output and follows the normal buffer after returning", async () => {
    const { pane, terminal } = createPane();
    await write(pane, terminal, lines(100));
    terminal.scrollToTop();

    await write(pane, terminal, "\x1b[?1049h\x1b[2J\x1b[Hfull-screen application");

    expect(terminal.buffer.active.type).toBe("alternate");
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "full-screen application",
    );
    await write(pane, terminal, "\x1b[?1049lback to shell\r\n");
    expect(terminal.buffer.active.type).toBe("normal");
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);
  });
});
