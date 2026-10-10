import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { TerminalPane } from "./terminal-pane";
import {
  searchTerminalLines,
  type SearchRequest,
  type SearchResponse,
} from "./terminal-search-engine";

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

class SearchWorker {
  static instances: SearchWorker[] = [];
  static stalled = false;
  onmessage: ((event: MessageEvent<SearchResponse>) => void) | undefined;
  onerror: (() => void) | undefined;
  terminated = false;
  constructor() {
    SearchWorker.instances.push(this);
  }
  postMessage(request: SearchRequest): void {
    if (!SearchWorker.stalled)
      setTimeout(() => {
        if (!this.terminated)
          this.onmessage?.({ data: searchTerminalLines(request) } as MessageEvent<SearchResponse>);
      }, 1);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const panes: TerminalPane[] = [];
function createPane() {
  const pane = new TerminalPane();
  panes.push(pane);
  document.body.append(pane.el);
  const term = terminals[terminals.length - 1];
  term.open(pane.bodyEl);
  const input = pane.el.querySelector<HTMLInputElement>(".terminal-search input")!;
  const status = pane.el.querySelector<HTMLElement>(".terminal-search-status")!;
  const bar = pane.el.querySelector<HTMLElement>(".terminal-search")!;
  const textarea = term.textarea!;
  return { pane, term, input, status, bar, textarea };
}

function key(target: HTMLElement, key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    keyCode: key === "Enter" ? 13 : key === "Escape" ? 27 : key.toUpperCase().charCodeAt(0),
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  target.dispatchEvent(event);
  return event;
}

async function write(term: Terminal, data: string) {
  await new Promise<void>((resolve) => term.write(data, resolve));
}

async function query(context: ReturnType<typeof createPane>, text: string, count: string) {
  context.input.value = text;
  context.input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(context.status.textContent).toBe(count));
}

beforeEach(() => {
  vi.stubGlobal("Worker", SearchWorker);
  vi.stubGlobal("matchMedia", () => ({ addListener() {}, removeListener() {} }));
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  SearchWorker.instances = [];
  SearchWorker.stalled = false;
});

afterEach(async () => {
  await Promise.all(panes.splice(0).map((pane) => pane.dispose()));
  terminals.length = 0;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("terminal search interaction", () => {
  it.each(["MacIntel", "Linux x86_64"])(
    "opens on %s without leaking keys to the terminal",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const context = createPane();
      await write(context.term, "hello HELLO hello");
      const data = vi.fn();
      context.term.onData(data);
      const event = key(
        context.textarea,
        "f",
        platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true },
      );
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(context.input);
      await query(context, "hello", "1/3");
      expect(context.pane.el.querySelectorAll(".terminal-search-match")).toHaveLength(3);
      expect(context.pane.el.querySelectorAll(".terminal-search-match.active")).toHaveLength(1);
      key(context.input, "Enter");
      expect(context.status.textContent).toBe("2/3");
      key(context.input, "Enter", { shiftKey: true });
      key(context.input, "Enter", { shiftKey: true });
      expect(context.status.textContent).toBe("3/3");
      key(context.input, "Escape");
      expect(context.bar.hidden).toBe(true);
      expect(document.activeElement).toBe(context.textarea);
      expect(context.pane.el.querySelectorAll(".terminal-search-match")).toHaveLength(0);
      expect(data).not.toHaveBeenCalled();
    },
  );

  it("preserves macOS Ctrl+F and ignores shortcuts in unrelated inputs", () => {
    const context = createPane();
    const data = vi.fn();
    context.term.onData(data);
    key(context.textarea, "f", { ctrlKey: true });
    expect(data.mock.calls[0]?.[0]).toBe("\x06");
    expect(context.bar.hidden).toBe(true);
    const unrelated = document.createElement("input");
    document.body.append(unrelated);
    expect(key(unrelated, "f", { metaKey: true }).defaultPrevented).toBe(false);
    expect(context.bar.hidden).toBe(true);
  });

  it("keeps query/options per pane and closes the old search without stealing focus", async () => {
    const first = createPane();
    const second = createPane();
    await write(first.term, "same SAME");
    await write(second.term, "same");
    key(first.textarea, "f", { metaKey: true });
    await query(first, "same", "1/2");
    first.pane.el.querySelector<HTMLButtonElement>('[aria-label="Match case"]')!.click();
    await vi.waitFor(() => expect(first.status.textContent).toBe("1/1"));
    second.term.focus();
    expect(first.bar.hidden).toBe(true);
    expect(document.activeElement).toBe(second.textarea);
    key(second.textarea, "f", { metaKey: true });
    expect(second.input.value).toBe("");
    key(first.textarea, "f", { metaKey: true });
    expect(second.bar.hidden).toBe(true);
    expect(first.input.value).toBe("same");
    expect(first.input.selectionEnd).toBe(4);
    await vi.waitFor(() => expect(first.status.textContent).toBe("1/1"));
  });

  it("keeps history visible during streaming, fitting and closing search", async () => {
    const context = createPane();
    await write(context.term, "target\r\n" + "output\r\n".repeat(200) + "target\r\n");
    key(context.textarea, "f", { metaKey: true });
    await query(context, "target", "1/2");
    const position = context.term.buffer.active.viewportY;
    await write(context.term, "target\r\n");
    context.pane.fit();
    expect(context.term.buffer.active.viewportY).toBe(position);
    await vi.waitFor(() => expect(context.status.textContent).toBe("1/3"));
    key(context.input, "Escape");
    expect(context.term.buffer.active.viewportY).toBe(position);
    await write(context.term, "more\r\n");
    expect(context.term.buffer.active.viewportY).toBe(position);
  });

  it("clears errors and pending workers on query changes, close and disposal", async () => {
    const context = createPane();
    await write(context.term, "hello");
    key(context.textarea, "f", { metaKey: true });
    context.pane.el
      .querySelector<HTMLButtonElement>('[aria-label="Use regular expression"]')!
      .click();
    await query(context, "(", "Invalid regular expression");
    expect(context.input.getAttribute("aria-invalid")).toBe("true");
    await query(context, "hello", "1/1");
    expect(context.input.getAttribute("aria-invalid")).toBe("false");
    await query(context, "", "0/0");
    expect(context.term.hasSelection()).toBe(false);
    SearchWorker.stalled = true;
    context.input.value = "slow";
    context.input.dispatchEvent(new Event("input"));
    await vi.waitFor(() =>
      expect(SearchWorker.instances[SearchWorker.instances.length - 1]?.terminated).toBe(false),
    );
    key(context.input, "Escape");
    expect(SearchWorker.instances.every((worker) => worker.terminated)).toBe(true);
    key(context.textarea, "f", { metaKey: true });
    await vi.waitFor(() =>
      expect(SearchWorker.instances[SearchWorker.instances.length - 1]?.terminated).toBe(false),
    );
    await context.pane.dispose();
    panes.splice(panes.indexOf(context.pane), 1);
    expect(SearchWorker.instances.every((worker) => worker.terminated)).toBe(true);
  });

  it("keeps results visible during redraws and refreshes before navigating changed output", async () => {
    const context = createPane();
    await write(context.term, "match match");
    key(context.textarea, "f", { metaKey: true });
    await query(context, "match", "1/2");
    await write(context.term, "\x1b[?25l");
    expect(context.status.textContent).toBe("1/2");
    expect(context.pane.el.querySelectorAll(".terminal-search-match")).toHaveLength(2);
    await write(context.term, "\r\x1b[2Kmatch");
    key(context.input, "Enter");
    await vi.waitFor(() => expect(context.status.textContent).toBe("1/1"));
    expect(context.pane.el.querySelectorAll(".terminal-search-match")).toHaveLength(1);
    expect(context.pane.el.querySelectorAll(".terminal-search-match.active")).toHaveLength(1);
  });

  it("terminates a slow search and recovers when the query is edited", async () => {
    const context = createPane();
    await write(context.term, "hello");
    SearchWorker.stalled = true;
    vi.useFakeTimers();
    key(context.textarea, "f", { metaKey: true });
    context.input.value = "slow";
    context.input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(1700);
    expect(context.status.textContent).toBe("Search took too long. Simplify your query.");
    expect(SearchWorker.instances.every((worker) => worker.terminated)).toBe(true);
    SearchWorker.stalled = false;
    context.input.value = "hello";
    context.input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(200);
    expect(context.status.textContent).toBe("1/1");
  });

  it("keeps the selected alternate-buffer result while output changes", async () => {
    const context = createPane();
    await write(context.term, "shell\x1b[?1049h\x1b[Hmatch match\r\n");
    key(context.textarea, "f", { metaKey: true });
    await query(context, "match", "1/2");
    key(context.input, "Enter");
    expect(context.status.textContent).toBe("2/2");
    await write(context.term, "match");
    await vi.waitFor(() => expect(context.status.textContent).toBe("2/3"));
    expect(context.pane.el.querySelectorAll(".terminal-search-match.active")).toHaveLength(1);
    await write(context.term, "\x1b[?1049l");
    await vi.waitFor(() => expect(context.status.textContent).toBe("0/0"));
    expect(context.pane.el.querySelectorAll(".terminal-search-match")).toHaveLength(0);
  });

  it("refreshes results after scrollback eviction and resize", async () => {
    const context = createPane();
    await write(context.term, "needle\r\n" + "row\r\n".repeat(40) + "needle\r\n");
    key(context.textarea, "f", { metaKey: true });
    await query(context, "needle", "1/2");
    context.term.resize(40, 12);
    await vi.waitFor(() => expect(context.status.textContent).toBe("1/2"));
    await write(context.term, "row\r\n".repeat(5012) + "needle\r\n");
    await vi.waitFor(() => expect(context.status.textContent).toBe("1/1"));
    key(context.input, "Enter");
    expect(context.pane.el.querySelectorAll(".terminal-search-match.active")).toHaveLength(1);
    expect(context.term.buffer.active.viewportY).toBeGreaterThan(4900);
  });

  it("ignores late worker replies after a newer query and queues navigation", async () => {
    const context = createPane();
    await write(context.term, "first second second");
    SearchWorker.stalled = true;
    key(context.textarea, "f", { metaKey: true });
    context.input.value = "first";
    context.input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(SearchWorker.instances).toHaveLength(1));
    const old = SearchWorker.instances[0];
    context.input.value = "second";
    context.input.dispatchEvent(new Event("input"));
    SearchWorker.stalled = false;
    key(context.input, "Enter");
    key(context.input, "Enter");
    old.onmessage?.({ data: { matches: new Uint32Array([0, 5]) } } as MessageEvent<SearchResponse>);
    await vi.waitFor(() => expect(context.status.textContent).toBe("2/2"));
    expect(context.pane.el.querySelectorAll(".terminal-search-match.active")).toHaveLength(1);
  });

  it("aligns highlights to rendered glyphs when WebKit cell measurements differ", async () => {
    const context = createPane();
    await write(context.term, "hello");
    const screen = context.term.element!.querySelector(".xterm-screen")!;
    vi.spyOn(screen, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 40, 800, 480));
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, "createRange").mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = () => new DOMRect(100, 60, 50, 20);
      return range;
    });
    key(context.textarea, "f", { metaKey: true });
    await query(context, "hello", "1/1");
    const mark = context.pane.el.querySelector<HTMLElement>(".terminal-search-match.active")!;
    expect(mark.style.left).toBe("80px");
    expect(mark.style.width).toBe("50px");
    expect(context.term.hasSelection()).toBe(false);
  });
});
