import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, ptyKill, panes, FakePane } = vi.hoisted(() => {
  const panes: FakePane[] = [];
  class FakePane {
    ptyId = "";
    attached: unknown = null;
    exited = false;
    written: string[] = [];
    fitted = 0;
    disposed = false;
    constructor() {
      panes.push(this);
    }
    attach(_host: HTMLElement, opts: unknown): Promise<void> {
      this.attached = opts;
      this.ptyId = `pty-${panes.length}`;
      return Promise.resolve();
    }
    write(data: string): void {
      this.written.push(data);
    }
    markExited(): void {
      this.exited = true;
    }
    fit(): void {
      this.fitted += 1;
    }
    focus(): void {}
    dispose(): Promise<void> {
      this.disposed = true;
      return Promise.resolve();
    }
  }
  return {
    invoke: vi.fn<(command: string, ...rest: unknown[]) => Promise<unknown>>(),
    ptyKill: vi.fn<(id: string) => Promise<undefined>>(() => Promise.resolve(undefined)),
    panes,
    FakePane,
  };
});

vi.mock("../../shared/tauri/invoke", () => ({
  invoke: (command: string, ...rest: unknown[]) => invoke(command, ...rest),
}));
vi.mock("../terminal/pty-client", () => ({ ptyKill: (id: string) => ptyKill(id) }));
vi.mock("../terminal/terminal-pane", () => ({
  TerminalPane: class {
    constructor() {
      return new FakePane();
    }
  },
}));

import { mountAgentPanel } from "./agent-panel";

const detected = [
  { id: "claude", label: "Claude Code", command: "claude", path: "/bin/claude" },
  { id: "codex", label: "Codex", command: "codex", path: null },
  { id: "gemini", label: "Gemini", command: "gemini", path: "/bin/gemini" },
];

const spec = {
  cli: "claude",
  cwd: "/data/agent-home",
  command: "claude",
  args: ["--mcp-config", "x"],
};

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("agent panel", () => {
  let host: HTMLElement;

  beforeEach(() => {
    panes.length = 0;
    invoke.mockReset();
    ptyKill.mockClear();
    invoke.mockImplementation((command: string) => {
      if (command === "agent_cli_detect") return Promise.resolve(detected);
      if (command === "agent_home_prepare") return Promise.resolve(spec);
      return Promise.reject(new Error(`unexpected ${command}`));
    });
    host = document.createElement("div");
    document.body.append(host);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    host.remove();
    vi.unstubAllGlobals();
  });

  it("lists installed CLIs on activate and disables the missing ones", async () => {
    const onCliChange = vi.fn();
    const panel = mountAgentPanel(host, {
      isVisible: () => true,
      initialCli: "gemini",
      onCliChange,
    });
    panel.activate();
    await flush();
    const select = host.querySelector<HTMLSelectElement>(".agent-panel-select")!;
    const options = [...select.options];
    expect(options.map((o) => o.textContent)).toEqual([
      "Claude Code",
      "Codex (not installed)",
      "Gemini",
    ]);
    expect(options[1].disabled).toBe(true);
    expect(select.value).toBe("gemini");
    expect(panes).toHaveLength(0);
    select.value = "claude";
    select.dispatchEvent(new Event("change"));
    expect(onCliChange).toHaveBeenCalledWith("claude");
    await panel.dispose();
  });

  it("falls back to the first installed CLI when the saved one is missing", async () => {
    const panel = mountAgentPanel(host, { isVisible: () => true, initialCli: "codex" });
    panel.activate();
    await flush();
    expect(host.querySelector<HTMLSelectElement>(".agent-panel-select")!.value).toBe("claude");
    await panel.dispose();
  });

  it("starts the chosen CLI in the agent home, routes its PTY and relaunches after exit", async () => {
    const panel = mountAgentPanel(host, { isVisible: () => true, initialCli: "claude" });
    panel.activate();
    await flush();
    host.querySelector<HTMLButtonElement>(".agent-panel-start")!.click();
    await flush();

    expect(invoke).toHaveBeenCalledWith(
      "agent_home_prepare",
      { cli: "claude" },
      { toastOnError: false },
    );
    expect(panes).toHaveLength(1);
    expect(panes[0].attached).toEqual({
      command: "claude",
      args: ["--mcp-config", "x"],
      cwd: "/data/agent-home",
      cliId: "claude",
    });
    expect(host.querySelector<HTMLButtonElement>(".agent-panel-start")!.hidden).toBe(true);
    expect(host.querySelector<HTMLSelectElement>(".agent-panel-select")!.disabled).toBe(true);

    expect(panel.handlePtyData("other", "x")).toBe(false);
    expect(panel.handlePtyData("pty-1", "hello")).toBe(true);
    expect(panes[0].written).toEqual(["hello"]);

    expect(panel.handlePtyExit("pty-1")).toBe(true);
    expect(panes[0].exited).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(".agent-panel-start")!.hidden).toBe(false);
    expect(host.querySelector(".agent-panel-status")!.textContent).toMatch(/exited/);

    host.querySelector<HTMLButtonElement>(".agent-panel-start")!.click();
    await flush();
    expect(panes).toHaveLength(2);
    expect(panes[0].disposed).toBe(true);

    host.querySelector<HTMLButtonElement>(".agent-panel-stop")!.click();
    await flush();
    expect(ptyKill).toHaveBeenCalledWith("pty-2");
    expect(panes[1].disposed).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(".agent-panel-stop")!.hidden).toBe(true);
    await panel.dispose();
  });

  it("reports a failed launch and keeps the picker usable", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "agent_cli_detect") return Promise.resolve(detected);
      return Promise.reject(new Error("boom"));
    });
    const panel = mountAgentPanel(host, { isVisible: () => true, initialCli: "claude" });
    panel.activate();
    await flush();
    host.querySelector<HTMLButtonElement>(".agent-panel-start")!.click();
    await flush();
    expect(host.querySelector(".agent-panel-status")!.textContent).toMatch(
      /Could not start claude/,
    );
    expect(host.querySelector<HTMLButtonElement>(".agent-panel-start")!.hidden).toBe(false);
    expect(panes).toHaveLength(0);
    await panel.dispose();
  });
});
