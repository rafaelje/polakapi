import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { TerminalCommandOutput } from "./terminal-command-output";
import { TerminalBlockActions } from "./terminal-block-actions";

const clipboard = vi.hoisted(() => ({
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn(),
}));
vi.hoisted(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
vi.mock("@tauri-apps/plugin-clipboard-manager", () => clipboard);

describe("terminal block actions", () => {
  const disposables: Array<{ dispose(): void }> = [];
  afterEach(() => {
    disposables
      .splice(0)
      .reverse()
      .forEach((item) => item.dispose());
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  async function setup() {
    const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    const history = new TerminalCommandOutput(term);
    const host = document.createElement("div");
    host.innerHTML = '<div class="xterm-screen"></div>';
    document.body.append(host);
    vi.spyOn(host.querySelector(".xterm-screen")!, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 400, 100),
    );
    const actions = new TerminalBlockActions(term, host, history);
    disposables.push(term, history, actions);
    const write = (text: string) => new Promise<void>((resolve) => term.write(text, resolve));
    history.prompt();
    await write("$ first\r\n");
    history.start("first");
    await write("one\r\n");
    history.prompt();
    await write("$ second\r\n");
    history.start("second");
    await write("two\r\n");
    history.prompt();
    await write("$ ");
    const hover = (y: number) =>
      host.dispatchEvent(new MouseEvent("mousemove", { clientX: 20, clientY: y }));
    return { host, hover, term, history, actions };
  }

  it("shows a block-local control only over command/output, not the empty prompt", async () => {
    const { host, hover } = await setup();
    const button = host.querySelector<HTMLButtonElement>(".terminal-block-menu-btn")!;
    expect(button.hidden).toBe(true);
    hover(15);
    expect(button.hidden).toBe(false);
    expect(button.getAttribute("aria-label")).toContain("first");
    hover(45);
    expect(button.hidden).toBe(true);
  });

  it("copies an older block's command/output/both rather than the latest block", async () => {
    const { host, hover } = await setup();
    for (const [label, expected] of [
      ["Copy", "first\none\n"],
      ["Copy command", "first"],
      ["Copy output", "one\n"],
    ]) {
      hover(15);
      host.querySelector<HTMLButtonElement>(".terminal-block-menu-btn")!.click();
      document
        .querySelector<HTMLButtonElement>(`[role="menuitem"][aria-label="${label}"]`)!
        .click();
      expect(clipboard.writeText).toHaveBeenLastCalledWith(expected);
    }
  });

  it("targets right-clicked blocks and keeps selection copy and paste outside blocks", async () => {
    const { host, term } = await setup();
    host.dispatchEvent(
      new MouseEvent("contextmenu", { clientX: 20, clientY: 35, cancelable: true }),
    );
    document.querySelector<HTMLButtonElement>('[aria-label="Copy command"]')!.click();
    expect(clipboard.writeText).toHaveBeenLastCalledWith("second");
    vi.spyOn(term, "getSelection").mockReturnValue("selected text");
    host.dispatchEvent(
      new MouseEvent("contextmenu", { clientX: 20, clientY: 45, cancelable: true }),
    );
    expect(document.querySelector('[aria-label="Copy command"]')).toBeNull();
    expect(document.querySelector('[aria-label="Paste"]')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('[aria-label="Copy"]')!.click();
    expect(clipboard.writeText).toHaveBeenLastCalledWith("selected text");
    clipboard.readText.mockResolvedValue("pasted text");
    const paste = vi.spyOn(term, "paste").mockImplementation(() => {});
    host.dispatchEvent(new MouseEvent("contextmenu", { clientX: 20, clientY: 45 }));
    document.querySelector<HTMLButtonElement>('[aria-label="Paste"]')!.click();
    await vi.waitFor(() => expect(paste).toHaveBeenCalledExactlyOnceWith("pasted text"));
  });

  it.each(["", "selected text"])(
    "falls back to selection copy when running output is unavailable (selection: %s)",
    async (selection) => {
      const { host, term, history } = await setup();
      await new Promise<void>((resolve) => term.write("running\r\n", resolve));
      history.start("running");
      await new Promise<void>((resolve) => term.write("partial", resolve));
      term.resize(40, 11);
      vi.spyOn(term, "getSelection").mockReturnValue(selection);
      host.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true }));
      const copy = document.querySelector<HTMLButtonElement>('[aria-label="Copy"]')!;
      expect(copy.disabled).toBe(!selection);
      expect(
        document.querySelector<HTMLButtonElement>('[aria-label="Copy output"]')!.disabled,
      ).toBe(true);
      expect(
        document.querySelector<HTMLButtonElement>('[aria-label="Copy command"]')!.disabled,
      ).toBe(false);
      copy.click();
      if (selection) expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(selection);
      else expect(clipboard.writeText).not.toHaveBeenCalled();
    },
  );

  it("copies a silent command when its output is empty but available", async () => {
    const { host, history, term } = await setup();
    await new Promise<void>((resolve) => term.write("true\r\n", resolve));
    history.start("true");
    history.finish();
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true }));
    const copy = document.querySelector<HTMLButtonElement>('[aria-label="Copy"]')!;
    expect(copy.disabled).toBe(false);
    copy.click();
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith("true");
  });

  it("returns focus to the terminal when the block menu is dismissed", async () => {
    const { host, term } = await setup();
    vi.stubGlobal("matchMedia", () => ({ addListener() {}, removeListener() {} }));
    term.open(host);
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true }));
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(term.textarea);
    vi.unstubAllGlobals();
  });

  it("cleans up menus and the hover control on disposal", async () => {
    const { host, hover, actions } = await setup();
    hover(15);
    host.querySelector<HTMLButtonElement>(".terminal-block-menu-btn")!.click();
    actions.dispose();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(host.querySelector(".terminal-block-menu-btn")).toBeNull();
  });
});
