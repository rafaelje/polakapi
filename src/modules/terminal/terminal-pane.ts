import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ptySpawn, ptyWrite, ptyResize, ptyKill } from "./pty-client";
import { terminalTheme } from "./terminal-theme";
import { openPaneMenu } from "./terminal-pane-menu";
import type { StartupCmdEditCallbacks } from "./terminal-pane-types";
import { type PaneCreateOptions } from "./types";

export type { StartupCmdEditCallbacks };

export class TerminalPane {
  ptyId = "";
  readonly el: HTMLElement;
  readonly bodyEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly closeBtn: HTMLButtonElement;
  readonly menuBtn: HTMLButtonElement;
  private term: Terminal;
  private fitAddon: FitAddon;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private startupCmdCallbacks: StartupCmdEditCallbacks | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pane";
    this.el.style.flex = "1 1 0";

    const header = document.createElement("div");
    header.className = "pane-header";
    this.titleEl = document.createElement("div");
    this.titleEl.className = "title";
    this.titleEl.textContent = "shell";
    this.menuBtn = document.createElement("button");
    this.menuBtn.type = "button";
    this.menuBtn.className = "pane-menu-btn";
    this.menuBtn.textContent = "⋮";
    this.menuBtn.title = "Pane menu";
    this.closeBtn = document.createElement("button");
    this.closeBtn.textContent = "×";
    this.closeBtn.title = "Close terminal";
    header.append(this.titleEl, this.menuBtn, this.closeBtn);
    this.menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openPaneMenu();
    });

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "pane-body";
    this.el.append(header, this.bodyEl);

    this.term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: terminalTheme,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon());
  }

  async attach(host: HTMLElement, opts?: PaneCreateOptions): Promise<void> {
    host.append(this.el);
    this.term.open(this.bodyEl);
    this.safeFit();

    this.ptyId = await ptySpawn({
      cols: this.term.cols ?? 80,
      rows: this.term.rows ?? 24,
      command: opts?.command,
      args: opts?.args,
      cwd: opts?.cwd,
    });

    this.titleEl.textContent = opts?.command
      ? `${opts.command} · ${this.ptyId.slice(0, 6)}`
      : `shell · ${this.ptyId.slice(0, 6)}`;

    this.disposables.push(
      this.term.onData((data) => {
        void ptyWrite(this.ptyId, data);
      }),
      this.term.onResize(({ cols, rows }) => {
        void ptyResize(this.ptyId, cols, rows);
      }),
    );
  }

  write(data: string): void {
    this.term.write(data);
  }

  markExited(): void {
    this.term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
  }

  fit(): void {
    this.safeFit();
    if (!this.ptyId) return;
    void ptyResize(this.ptyId, this.term.cols, this.term.rows);
  }

  focus(): void {
    this.term.focus();
  }

  /**
   * F5: thin wrapper around xterm's `onBell`. Returns the IDisposable directly
   * so the notification module can tear it down without holding a reference to
   * the underlying Terminal instance. Also tracked here in `disposables` so a
   * pane.dispose() always cleans up even if the caller forgets to dispose.
   */
  onBell(callback: () => void): { dispose(): void } {
    const xtermDisposable = this.term.onBell(callback);
    const wrapper = {
      dispose: (): void => {
        xtermDisposable.dispose();
        const idx = this.disposables.indexOf(wrapper);
        if (idx >= 0) this.disposables.splice(idx, 1);
      },
    };
    this.disposables.push(wrapper);
    return wrapper;
  }

  /**
   * Wires the callbacks that drive the "Edit startup command" menu item.
   * Called by TerminalManager once the spec for this pane is known. Without
   * callbacks the menu still opens but the item is hidden.
   */
  setStartupCmdCallbacks(callbacks: StartupCmdEditCallbacks | null): void {
    this.startupCmdCallbacks = callbacks;
  }

  private openPaneMenu(): void {
    const callbacks = this.startupCmdCallbacks;
    if (!callbacks) return;
    openPaneMenu({
      trigger: this.menuBtn,
      getStartupCmd: () => callbacks.getStartupCmd(),
      onChangeStartupCmd: (next) => callbacks.onChange(next),
    });
  }

  private safeFit(): void {
    try {
      this.fitAddon.fit();
    } catch {
      // Pane may be detached; layout will refit later.
    }
  }

  async dispose(): Promise<void> {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.term.dispose();
    this.el.remove();
    if (!this.ptyId) return;
    const ptyId = this.ptyId;
    this.ptyId = "";
    try {
      await ptyKill(ptyId);
    } catch {
      // Already gone.
    }
  }
}
