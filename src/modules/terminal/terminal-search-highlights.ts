import type { Terminal } from "@xterm/xterm";

export class TerminalSearchHighlights {
  private readonly el = document.createElement("div");

  constructor(private readonly term: Terminal) {
    this.el.className = "terminal-search-highlights";
    this.el.setAttribute("aria-hidden", "true");
  }

  render(matches: Uint32Array, active: number): void {
    const screen = this.term.element?.querySelector(".xterm-screen");
    if (!screen) return;
    if (this.el.parentElement !== screen) screen.append(this.el);
    const { cols, rows } = this.term;
    const top = this.term.buffer.active.viewportY;
    const start = top * cols;
    const end = (top + rows) * cols;
    let low = 0;
    let high = matches.length / 2;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (matches[mid * 2 + 1] <= start) low = mid + 1;
      else high = mid;
    }
    const fragment = document.createDocumentFragment();
    const screenRect = screen.getBoundingClientRect();
    const renderedRows = screen.querySelector(".xterm-rows");
    for (let index = low; index < matches.length / 2 && matches[index * 2] < end; index++) {
      const from = Math.max(start, matches[index * 2]);
      const to = Math.min(end, matches[index * 2 + 1]);
      for (let position = from; position < to; ) {
        const col = position % cols;
        const width = Math.min(cols - col, to - position);
        const mark = document.createElement("span");
        mark.className =
          index === active ? "terminal-search-match active" : "terminal-search-match";
        mark.style.left = `${(col / cols) * 100}%`;
        mark.style.top = `${((Math.floor(position / cols) - top) / rows) * 100}%`;
        mark.style.width = `${(width / cols) * 100}%`;
        mark.style.height = `${100 / rows}%`;
        const row = Math.floor(position / cols);
        const renderedRow = renderedRows?.children[row - top];
        const bufferLine = this.term.buffer.active.getLine(row);
        // WebKit's rendered glyph bounds can differ from xterm's measured cell grid.
        if (renderedRow && bufferLine) {
          const rect = textRangeRect(
            renderedRow,
            bufferLine.translateToString(false, 0, col).length,
            bufferLine.translateToString(false, 0, col + width).length,
          );
          if (rect) {
            mark.style.left = `${rect.left - screenRect.left}px`;
            mark.style.top = `${renderedRow.getBoundingClientRect().top - screenRect.top}px`;
            mark.style.width = `${rect.width}px`;
            mark.style.height = `${renderedRow.getBoundingClientRect().height}px`;
          }
        }
        fragment.append(mark);
        position += width;
      }
    }
    this.el.replaceChildren(fragment);
  }

  clear(): void {
    this.el.replaceChildren();
  }

  dispose(): void {
    this.el.remove();
  }
}

function textRangeRect(element: Element, start: number, end: number): DOMRect | undefined {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  if (typeof range.getBoundingClientRect !== "function") return;
  let node: Node | null;
  let offset = 0;
  let started = false;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range.getBoundingClientRect();
    }
    offset += length;
  }
}
