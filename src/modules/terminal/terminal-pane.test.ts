import { beforeEach, describe, expect, it, vi } from "vitest";

type LinkHandler = (event: MouseEvent, text: string) => void;

const linkMocks = vi.hoisted(() => ({
  openLinkFromText: vi.fn<(text: string) => void>(),
}));

const terminalMocks = vi.hoisted(() => {
  let oscHandler: LinkHandler | null = null;
  class Terminal {
    cols = 80;
    rows = 24;

    constructor(options: { linkHandler: { activate: LinkHandler } }) {
      oscHandler = options.linkHandler.activate;
    }

    readonly written: string[] = [];

    loadAddon(): void {}

    write(data: string, callback?: () => void): void {
      this.written.push(data);
      callback?.();
    }
  }

  return {
    Terminal,
    oscHandler: (): LinkHandler | null => oscHandler,
  };
});

const webLinkMocks = vi.hoisted(() => {
  let handler: LinkHandler | null = null;
  class WebLinksAddon {
    constructor(callback: LinkHandler) {
      handler = callback;
    }
  }

  return {
    WebLinksAddon,
    handler: (): LinkHandler | null => handler,
  };
});

vi.mock("@xterm/xterm", () => ({ Terminal: terminalMocks.Terminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize(): string {
      return "\u001b[31mred";
    }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: webLinkMocks.WebLinksAddon }));
vi.mock("./terminal-links", () => ({
  isPrimaryClick: (event: MouseEvent) => event.button === 0,
  openLinkFromText: linkMocks.openLinkFromText,
}));

import { TerminalPane } from "./terminal-pane";

describe("TerminalPane hyperlink activation", () => {
  beforeEach(() => {
    linkMocks.openLinkFromText.mockClear();
    new TerminalPane();
  });

  it.each([
    ["OSC 8", () => terminalMocks.oscHandler()],
    ["plain-text URL", () => webLinkMocks.handler()],
  ])("ignores non-primary clicks for %s links", (_name, getHandler) => {
    const preventDefault = vi.fn();
    const event = { button: 2, preventDefault } as unknown as MouseEvent;

    getHandler()?.(event, "https://example.com");

    expect(preventDefault).not.toHaveBeenCalled();
    expect(linkMocks.openLinkFromText).not.toHaveBeenCalled();
  });

  it.each([
    ["OSC 8", () => terminalMocks.oscHandler()],
    ["plain-text URL", () => webLinkMocks.handler()],
  ])("opens %s links on primary click", (_name, getHandler) => {
    const preventDefault = vi.fn();
    const event = { button: 0, preventDefault } as unknown as MouseEvent;

    getHandler()?.(event, "https://example.com");

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(linkMocks.openLinkFromText).toHaveBeenCalledExactlyOnceWith("https://example.com");
  });
});

describe("TerminalPane handover between windows", () => {
  const written = (pane: TerminalPane): string[] =>
    (pane as unknown as { term: { written: string[] } }).term.written;

  it("drops output it already showed", () => {
    const pane = new TerminalPane();
    pane.write("a", 5);
    pane.write("a", 5);
    pane.write("b", 3);
    pane.write("c", 9);
    expect(written(pane)).toEqual(["a", "c"]);
  });

  it("retains raw output when parser boundary inspection is unavailable", async () => {
    const pane = new TerminalPane();
    pane.ptyId = "pty-1";
    pane.write("x", 12);
    await expect(pane.snapshot()).resolves.toEqual({
      screen: "",
      replay: "x",
      offset: 12,
      cols: 80,
      rows: 24,
    });
  });

  it("has nothing to hand over without a process", async () => {
    await expect(new TerminalPane().snapshot()).resolves.toBeNull();
  });
});
