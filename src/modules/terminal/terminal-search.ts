import type { IDisposable, IMarker, Terminal } from "@xterm/xterm";
import { isMacPlatform } from "../../shared/keyboard/shortcuts";
import { snapshotSearchLines, type SearchResponse } from "./terminal-search-engine";
import { TerminalSearchHighlights } from "./terminal-search-highlights";
import { TerminalSearchView } from "./terminal-search-view";

export class TerminalSearch {
  private readonly view: TerminalSearchView;
  private readonly highlights: TerminalSearchHighlights;
  private readonly disposables: IDisposable[];
  private matches = new Uint32Array();
  private active = 0;
  private anchor: IMarker | undefined;
  private anchorCol = 0;
  private anchorPosition: number | undefined;
  private worker: Worker | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private refresh: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private resultsRevision = -1;
  private pendingDirection: number | undefined;
  private failed = false;

  constructor(
    private readonly term: Terminal,
    private readonly pane: HTMLElement,
    body: HTMLElement,
  ) {
    this.highlights = new TerminalSearchHighlights(term);
    this.view = new TerminalSearchView(
      () => this.changed(),
      (direction) => this.navigate(direction),
      () => this.close(),
    );
    body.append(this.view.el);
    pane.addEventListener("keydown", this.onKey, true);
    document.addEventListener("focusin", this.onFocus);
    document.addEventListener("mousedown", this.onFocus);
    this.disposables = [
      term.onWriteParsed(() => this.bufferChanged()),
      term.onResize(() => this.bufferChanged(true)),
      term.onScroll(() => {
        if (this.isOpen) this.highlights.render(this.matches, this.active);
      }),
      term.onRender(() => {
        if (this.isOpen) this.highlights.render(this.matches, this.active);
      }),
      term.buffer.onBufferChange(() => {
        this.clearAnchor();
        this.bufferChanged(true);
      }),
    ];
  }

  get isOpen(): boolean {
    return !this.view.el.hidden;
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    const primary = isMacPlatform()
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    const find = primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f";
    if (find) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.open();
    } else if (this.isOpen && event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close();
    } else if (event.target === this.view.input && event.key === "Enter") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.navigate(event.shiftKey ? -1 : 1);
    }
  };

  private readonly onFocus = (event: Event): void => {
    if (event.target instanceof Element) {
      const other = event.target.closest(".pane");
      if (other && other !== this.pane) this.close(false);
    }
  };

  open(): void {
    const wasOpen = this.isOpen;
    this.view.el.hidden = false;
    this.view.input.focus();
    this.view.input.select();
    if (!wasOpen) this.changed();
  }

  close(focus = true): void {
    if (!this.isOpen) return;
    this.view.el.hidden = true;
    this.cancel();
    this.clearAnchor();
    this.matches = new Uint32Array();
    this.highlights.clear();
    this.term.clearSelection();
    if (focus) this.term.focus();
  }

  private changed(): void {
    this.cancel();
    this.failed = false;
    this.pendingDirection = undefined;
    this.clearAnchor();
    this.term.clearSelection();
    this.invalidate();
    if (this.view.input.value) this.refresh = setTimeout(() => this.search(true), 100);
  }

  private invalidate(): void {
    this.resultsRevision = -1;
    this.matches = new Uint32Array();
    this.highlights.clear();
    this.view.update(0, 0, this.view.input.value ? "Searching…" : undefined);
  }

  private bufferChanged(clear = false): void {
    this.revision++;
    if (!this.isOpen || !this.view.input.value || this.failed) return;
    if (clear) this.invalidate();
    if (!this.refresh && !this.worker) this.refresh = setTimeout(() => this.search(false), 150);
  }

  private search(scroll: boolean): void {
    clearTimeout(this.refresh);
    this.refresh = undefined;
    if (!this.isOpen || !this.view.input.value) return;
    const revision = this.revision;
    try {
      const worker = new Worker(new URL("./terminal-search.worker.ts", import.meta.url), {
        type: "module",
      });
      this.worker = worker;
      worker.onmessage = (event: MessageEvent<SearchResponse>) => {
        if (this.worker !== worker) return;
        this.stopWorker();
        if (revision !== this.revision) {
          this.search(scroll);
          return;
        }
        if (event.data.error) {
          this.fail(event.data.error);
          return;
        }
        this.matches = event.data.matches;
        this.resultsRevision = revision;
        this.active = 0;
        const position = this.anchor
          ? this.anchor.isDisposed
            ? undefined
            : this.anchor.line * this.term.cols + this.anchorCol
          : this.anchorPosition;
        if (position !== undefined) {
          const index = this.matches.findIndex((value, i) => i % 2 === 0 && value >= position);
          if (index >= 0) this.active = index / 2;
        }
        const count = this.matches.length / 2;
        if (count)
          this.active = (this.active + ((this.pendingDirection ?? 0) % count) + count) % count;
        this.select(scroll || this.pendingDirection !== undefined);
        this.pendingDirection = undefined;
      };
      worker.onerror = () => {
        if (this.worker === worker) this.fail("Search unavailable. Try again.");
      };
      this.timeout = setTimeout(
        () => this.fail("Search took too long. Simplify your query."),
        1500,
      );
      worker.postMessage({
        lines: snapshotSearchLines(this.term),
        query: this.view.input.value,
        options: this.view.options,
      });
    } catch {
      this.fail("Search unavailable. Try again.");
    }
  }

  private navigate(direction: number): void {
    const count = this.matches.length / 2;
    if (!count || this.resultsRevision !== this.revision) {
      if (this.refresh || this.worker) {
        this.pendingDirection =
          this.pendingDirection !== undefined
            ? this.pendingDirection + direction
            : this.anchorPosition !== undefined
              ? direction
              : Math.min(direction, 0);
        if (this.refresh) this.search(true);
      }
      return;
    }
    this.active = (this.active + direction + count) % count;
    this.select(true);
  }

  private select(scroll: boolean): void {
    const count = this.matches.length / 2;
    this.view.update(this.active, count);
    if (count) {
      const start = this.matches[this.active * 2];
      const row = Math.floor(start / this.term.cols);
      this.clearAnchor();
      this.anchorPosition = start;
      this.anchorCol = start % this.term.cols;
      this.anchor = this.term.registerMarker(
        row - this.term.buffer.active.baseY - this.term.buffer.active.cursorY,
      );
      if (scroll) {
        this.term.scrollToLine(Math.max(0, row - Math.floor(this.term.rows / 2)));
      }
    } else {
      this.clearAnchor();
      this.term.clearSelection();
    }
    this.highlights.render(this.matches, this.active);
  }

  private clearAnchor(): void {
    this.anchor?.dispose();
    this.anchor = undefined;
    this.anchorPosition = undefined;
  }

  private fail(message: string): void {
    this.cancel();
    this.failed = true;
    this.matches = new Uint32Array();
    this.highlights.clear();
    this.term.clearSelection();
    this.view.update(0, 0, message);
  }

  private stopWorker(): void {
    clearTimeout(this.timeout);
    this.worker?.terminate();
    this.worker = undefined;
  }

  private cancel(): void {
    clearTimeout(this.refresh);
    this.refresh = undefined;
    this.stopWorker();
  }

  dispose(): void {
    this.cancel();
    this.clearAnchor();
    for (const disposable of this.disposables) disposable.dispose();
    this.pane.removeEventListener("keydown", this.onKey, true);
    document.removeEventListener("focusin", this.onFocus);
    document.removeEventListener("mousedown", this.onFocus);
    this.highlights.dispose();
    this.view.el.remove();
  }
}
