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

    loadAddon(): void {}
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
