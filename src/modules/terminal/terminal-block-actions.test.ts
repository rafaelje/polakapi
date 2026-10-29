import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { TerminalCommandOutput } from "./terminal-command-output";
import { TerminalBlockActions } from "./terminal-block-actions";

const clipboard = vi.hoisted(() => ({
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn(),
}));
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
    const { host } = await setup();
    host.dispatchEvent(
      new MouseEvent("contextmenu", { clientX: 20, clientY: 35, cancelable: true }),
    );
    document.querySelector<HTMLButtonElement>('[aria-label="Copy command"]')!.click();
    expect(clipboard.writeText).toHaveBeenLastCalledWith("second");
    host.dispatchEvent(
      new MouseEvent("contextmenu", { clientX: 20, clientY: 45, cancelable: true }),
    );
    expect(document.querySelector('[aria-label="Copy command"]')).toBeNull();
    expect(document.querySelector('[aria-label="Paste"]')).not.toBeNull();
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
