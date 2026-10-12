import type { Terminal } from "@xterm/xterm";

export interface SearchOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface SearchLine {
  text: string;
  starts: number[];
  ends: number[];
}

export interface SearchRequest {
  lines: SearchLine[];
  query: string;
  options: SearchOptions;
}

export interface SearchResponse {
  matches: Uint32Array;
  error?: string;
}

export function snapshotSearchLines(term: Terminal): SearchLine[] {
  const buffer = term.buffer.active;
  const lines: SearchLine[] = [];
  let logical: SearchLine | undefined;
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (!logical || !line.isWrapped) {
      logical = { text: "", starts: [], ends: [] };
      lines.push(logical);
    }
    const next = buffer.getLine(row + 1);
    const wraps = next?.isWrapped;
    let text = line.translateToString(!wraps);
    const last = line.getCell(term.cols - 1);
    if (wraps && last?.getCode() === 0 && next?.getCell(0)?.getWidth() === 2) {
      text = text.slice(0, -1);
    }
    let offset = 0;
    for (let col = 0; col < term.cols && offset < text.length; col++) {
      const cell = line.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      for (let index = 0; index < chars.length; index++) {
        logical.starts.push(row * term.cols + col);
        logical.ends.push(row * term.cols + col + cell.getWidth());
      }
      offset += chars.length;
    }
    logical.text += text;
  }
  return lines;
}

export function searchTerminalLines({ lines, query, options }: SearchRequest): SearchResponse {
  if (!query) return { matches: new Uint32Array() };
  const pattern = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, options.caseSensitive ? "gu" : "giu");
  } catch {
    return { matches: new Uint32Array(), error: "Invalid regular expression" };
  }
  const matches: number[] = [];
  for (const line of lines) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line.text))) {
      const start = match.index;
      const end = start + match[0].length;
      if (end === start) {
        regex.lastIndex += (line.text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1;
        continue;
      }
      if (
        options.wholeWord &&
        (/[\p{L}\p{N}\p{M}_]$/u.test(line.text.slice(Math.max(0, start - 2), start)) ||
          /^[\p{L}\p{N}\p{M}_]/u.test(line.text.slice(end, end + 2)))
      ) {
        continue;
      }
      matches.push(line.starts[start], line.ends[end - 1]);
    }
  }
  return { matches: Uint32Array.from(matches) };
}
