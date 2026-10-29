import type { IMarker, Terminal } from "@xterm/xterm";

export interface TerminalCommandBlock {
  readonly command: string;
  readonly start: IMarker;
  readonly startColumn: number;
  rangeValid: boolean;
  end?: IMarker;
  endColumn: number;
  outputStart?: IMarker;
  outputColumn: number;
  output: string | null;
  running: boolean;
}

export interface TerminalBlockSnapshot {
  command: string;
  output: string | null;
}

const MAX_BLOCKS = 200;

export class TerminalCommandOutput {
  private history: TerminalCommandBlock[] = [];
  private current: TerminalCommandBlock | undefined;
  private nextPrompt: IMarker | undefined;
  private awaitingPrompt = false;
  private promptColumn = 0;
  private promptRangeValid = true;
  private latestCommand = "";
  private readonly disposables: Array<{ dispose(): void }>;

  constructor(private readonly term: Terminal) {
    let columns = term.cols;
    this.disposables = [
      term.onResize(() => {
        this.invalidateRange();
        if (columns !== term.cols) {
          for (const block of this.history) {
            if (block.startColumn || block.endColumn) block.rangeValid = false;
          }
          if (this.promptColumn) this.promptRangeValid = false;
        }
        columns = term.cols;
      }),
      term.buffer.onBufferChange(() => this.invalidateRange()),
    ];
  }

  get command(): string {
    return this.latestCommand;
  }
  get output(): string | null {
    return this.current ? this.snapshot(this.current).output : null;
  }

  get blocks(): readonly TerminalCommandBlock[] {
    this.history = this.history.filter((block) => {
      if (!block.start.isDisposed) return true;
      this.release(block);
      return false;
    });
    return this.history;
  }

  get latest(): TerminalCommandBlock | undefined {
    const blocks = this.blocks;
    return blocks[blocks.length - 1];
  }

  start(command: string): void {
    if (this.current?.running) {
      this.invalidateRange();
      this.finish();
    }
    this.latestCommand = command;
    this.awaitingPrompt = true;
    if (this.term.buffer.active.type !== "normal") return;
    const start =
      this.nextPrompt && !this.nextPrompt.isDisposed
        ? this.nextPrompt
        : this.term.registerMarker(this.term.buffer.active.cursorY > 0 ? -1 : 0);
    this.nextPrompt = undefined;
    const block: TerminalCommandBlock = {
      command,
      start,
      startColumn: this.promptColumn,
      rangeValid: this.promptRangeValid,
      endColumn: 0,
      output: null,
      running: true,
      outputStart: this.term.registerMarker(0),
      outputColumn: this.term.buffer.active.cursorX,
    };
    this.current = block;
    this.history.push(block);
    void this.blocks;
    while (this.history.length > MAX_BLOCKS) this.release(this.history.shift()!);
  }

  finish(): void {
    const block = this.current;
    if (!block?.running) return;
    block.output = this.readRange(block);
    block.running = false;
    block.outputStart?.dispose();
    block.outputStart = undefined;
    this.setEnd(block);
  }

  prompt(): void {
    this.finish();
    if (this.awaitingPrompt && this.current) this.setEnd(this.current);
    this.awaitingPrompt = false;
    this.promptColumn = this.term.buffer.active.cursorX;
    this.promptRangeValid = true;
    this.nextPrompt?.dispose();
    this.nextPrompt =
      this.term.buffer.active.type === "normal" ? this.term.registerMarker(0) : undefined;
  }

  blockAt(row: number, column: number): TerminalCommandBlock | undefined {
    if (this.term.buffer.active.type !== "normal") return undefined;
    return [...this.blocks].reverse().find((block) => {
      const end = block.running
        ? {
            line: this.term.buffer.active.baseY + this.term.buffer.active.cursorY,
            column: this.term.cols,
          }
        : block.end && !block.end.isDisposed
          ? { line: block.end.line, column: block.endColumn }
          : null;
      return (
        end &&
        block.rangeValid &&
        (row > block.start.line || (row === block.start.line && column >= block.startColumn)) &&
        (row < end.line || (row === end.line && column < end.column))
      );
    });
  }

  snapshot(block: TerminalCommandBlock): TerminalBlockSnapshot {
    return {
      command: block.command,
      output: block.start.isDisposed ? null : block.running ? this.readRange(block) : block.output,
    };
  }

  private setEnd(block: TerminalCommandBlock): void {
    block.end?.dispose();
    block.end = this.term.buffer.active.type === "normal" ? this.term.registerMarker(0) : undefined;
    block.endColumn = this.term.buffer.active.cursorX;
  }

  private readRange(block: TerminalCommandBlock): string | null {
    const buffer = this.term.buffer.active;
    const start = block.outputStart;
    if (!start || start.isDisposed || buffer.type !== "normal") return null;
    const endRow = buffer.baseY + buffer.cursorY;
    if (endRow < start.line) return null;
    let text = "";
    for (let row = start.line; row <= endRow; row++) {
      const line = buffer.getLine(row);
      if (!line) return null;
      if (row > start.line && !line.isWrapped) text += "\n";
      text += line.translateToString(true, row === start.line ? block.outputColumn : 0);
    }
    return text;
  }

  private invalidateRange(): void {
    this.current?.outputStart?.dispose();
    if (this.current) this.current.outputStart = undefined;
  }

  private release(block: TerminalCommandBlock): void {
    block.start.dispose();
    block.end?.dispose();
    block.outputStart?.dispose();
    block.output = null;
  }

  dispose(): void {
    this.history.forEach((block) => this.release(block));
    this.history = [];
    this.nextPrompt?.dispose();
    this.disposables.forEach((item) => item.dispose());
  }
}
