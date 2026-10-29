import type { Terminal } from "@xterm/xterm";
import {
  attachTerminalContextMenuGuard,
  copyTerminalSelection,
  copyTerminalText,
  pasteIntoTerminal,
} from "./terminal-clipboard";
import type { TerminalCommandOutput, TerminalCommandBlock } from "./terminal-command-output";
import { openTerminalContextMenu, type PaneMenuHandle } from "./terminal-pane-menu";

type Point = { x: number; y: number };

export class TerminalBlockActions {
  private readonly button = document.createElement("button");
  private hovered: TerminalCommandBlock | undefined;
  private point: Point | null = null;
  private menu: PaneMenuHandle | null = null;
  private readonly disposables: Array<{ dispose(): void }>;

  constructor(
    private readonly term: Terminal,
    private readonly host: HTMLElement,
    private readonly history: TerminalCommandOutput,
  ) {
    this.button.type = "button";
    this.button.className = "terminal-block-menu-btn";
    this.button.hidden = true;
    this.button.title = "Copy command block";
    this.button.setAttribute("aria-haspopup", "menu");
    this.button.setAttribute("aria-expanded", "false");
    this.button.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
    this.button.addEventListener("mousedown", (event) => event.preventDefault());
    this.button.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = this.button.getBoundingClientRect();
      this.open(this.hovered, { x: rect.right, y: rect.bottom });
    });
    host.append(this.button);
    host.addEventListener("mousemove", this.onMove);
    host.addEventListener("mouseleave", this.onLeave);
    host.addEventListener("keydown", this.onKey, true);
    this.disposables = [
      attachTerminalContextMenuGuard(host, (at) => this.open(this.blockAt(at), at)),
      term.onScroll(() => {
        this.close();
        this.refresh();
      }),
      term.onResize(() => {
        this.close();
        this.refresh();
      }),
      term.onRender(() => this.refresh()),
      term.onWriteParsed(() => this.refresh()),
      term.buffer.onBufferChange(() => {
        this.close();
        this.refresh();
      }),
    ];
  }

  copyCommand(): void {
    copyTerminalText(this.target()?.command ?? "");
  }
  copyOutput(): void {
    const block = this.target();
    copyTerminalText(block ? this.history.snapshot(block).output : null);
  }

  private target(): TerminalCommandBlock | undefined {
    return this.hovered && this.history.blocks.includes(this.hovered)
      ? this.hovered
      : this.history.latest;
  }

  private readonly onMove = (event: MouseEvent): void => {
    if (event.target === this.button || this.button.contains(event.target as Node)) return;
    this.point = { x: event.clientX, y: event.clientY };
    this.refresh();
  };
  private readonly onLeave = (): void => {
    this.point = null;
    this.refresh();
  };
  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    event.preventDefault();
    event.stopPropagation();
    const selection = this.term.getSelectionPosition();
    const block = selection
      ? this.history.blockAt(selection.start.y, selection.start.x)
      : this.history.latest;
    const rect = this.host.getBoundingClientRect();
    this.open(block, { x: rect.right - 20, y: rect.top + 10 });
  };

  private blockAt(at: Point): TerminalCommandBlock | undefined {
    const screen = this.host.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (
      !screen ||
      !screen.height ||
      !screen.width ||
      at.x < screen.left ||
      at.x >= screen.right ||
      at.y < screen.top ||
      at.y >= screen.bottom
    )
      return undefined;
    const row =
      this.term.buffer.active.viewportY +
      Math.floor(((at.y - screen.top) * this.term.rows) / screen.height);
    const col = Math.floor(((at.x - screen.left) * this.term.cols) / screen.width);
    return this.history.blockAt(row, col);
  }

  private refresh(): void {
    if (this.menu) return;
    this.hovered = this.point ? this.blockAt(this.point) : undefined;
    this.button.hidden = !this.hovered;
    if (!this.hovered) return;
    const screen = this.host.querySelector(".xterm-screen")!.getBoundingClientRect();
    const row = Math.max(0, this.hovered.start.line - this.term.buffer.active.viewportY);
    this.button.style.top = `${screen.top - this.host.getBoundingClientRect().top + (row * screen.height) / this.term.rows}px`;
    this.button.setAttribute("aria-label", `Copy block: ${this.hovered.command.slice(0, 80)}`);
  }

  private open(block: TerminalCommandBlock | undefined, at: Point): void {
    this.close();
    const selection = this.term.getSelection();
    const snapshot =
      block && this.history.blocks.includes(block) ? this.history.snapshot(block) : null;
    const both = snapshot ? snapshot.command + (snapshot.output ? `\n${snapshot.output}` : "") : "";
    this.button.setAttribute("aria-expanded", "true");
    this.menu = openTerminalContextMenu({
      at,
      hasSelection: () => Boolean(snapshot || selection),
      onCopy: () =>
        snapshot
          ? copyTerminalText(both)
          : copyTerminalSelection({ getSelection: () => selection }),
      onPaste: () => pasteIntoTerminal(this.term),
      commandActions: snapshot
        ? {
            ...snapshot,
            onCopyCommand: () => copyTerminalText(snapshot.command),
            onCopyOutput: () => copyTerminalText(snapshot.output),
          }
        : undefined,
      onCopySelection:
        snapshot && selection
          ? () => copyTerminalSelection({ getSelection: () => selection })
          : undefined,
      onClose: () => {
        this.menu = null;
        this.button.setAttribute("aria-expanded", "false");
        this.term.focus();
        this.refresh();
      },
    });
  }

  private close(): void {
    this.menu?.dispose();
  }

  dispose(): void {
    this.close();
    this.host.removeEventListener("mousemove", this.onMove);
    this.host.removeEventListener("mouseleave", this.onLeave);
    this.host.removeEventListener("keydown", this.onKey, true);
    this.disposables.forEach((item) => item.dispose());
    this.button.remove();
  }
}
