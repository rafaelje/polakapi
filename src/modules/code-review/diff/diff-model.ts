import type { FileContents, SideContent } from "../types";

export type DiffRowKind = "context" | "added" | "deleted" | "modified";

export interface TextRange {
  start: number;
  end: number;
}

export interface DiffLine {
  number: number;
  text: string;
  changes?: TextRange[];
}

export interface DiffRow {
  kind: DiffRowKind;
  left: DiffLine | null;
  right: DiffLine | null;
}

export type DiffOpKind = "equal" | "delete" | "insert";

export interface DiffOp {
  kind: DiffOpKind;
  oldIndex: number;
  newIndex: number;
}

export type UnifiedRowKind = "context" | "added" | "deleted";

export interface UnifiedRow {
  kind: UnifiedRowKind;
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
  changes?: TextRange[];
}

export type FoldItem =
  | { kind: "row"; index: number }
  | { kind: "fold"; start: number; end: number };

export type FileDiff = { kind: "rows"; rows: DiffRow[] } | { kind: "placeholder"; message: string };

const MAX_EDIT_DISTANCE = 2000;
const FOLD_CONTEXT = 3;
const MIN_FOLDED_ROWS = 2;

export function splitLines(text: string | null): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffContents(contents: FileContents): FileDiff {
  const sides = [contents.before, contents.after];
  const tooLarge = sides.flatMap((side) => (side.kind === "tooLarge" ? [side.bytes] : []));
  if (tooLarge.length > 0) {
    const megabytes = Math.max(...tooLarge) / (1024 * 1024);
    return {
      kind: "placeholder",
      message: `File is too large to show (${megabytes.toFixed(1)} MB).`,
    };
  }
  if (sides.some((side) => side.kind === "binary")) {
    return { kind: "placeholder", message: "Binary file, no text diff to show." };
  }
  return {
    kind: "rows",
    rows: sideBySideRows(sideText(contents.before), sideText(contents.after)),
  };
}

export function sideBySideRows(before: string | null, after: string | null): DiffRow[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const rows: DiffRow[] = [];
  let deletes: number[] = [];
  let inserts: number[] = [];
  const line = (lines: string[], index: number): DiffLine => ({
    number: index + 1,
    text: lines[index],
  });
  const flush = (): void => {
    const paired = Math.min(deletes.length, inserts.length);
    for (let i = 0; i < paired; i++) {
      const left = line(oldLines, deletes[i]);
      const right = line(newLines, inserts[i]);
      const changes = wordRanges(left.text, right.text);
      rows.push({
        kind: "modified",
        left: { ...left, changes: changes.left },
        right: { ...right, changes: changes.right },
      });
    }
    for (const index of deletes.slice(paired)) {
      rows.push({ kind: "deleted", left: line(oldLines, index), right: null });
    }
    for (const index of inserts.slice(paired)) {
      rows.push({ kind: "added", left: null, right: line(newLines, index) });
    }
    deletes = [];
    inserts = [];
  };

  for (const op of lineDiff(oldLines, newLines)) {
    if (op.kind === "delete") deletes.push(op.oldIndex);
    else if (op.kind === "insert") inserts.push(op.newIndex);
    else {
      flush();
      rows.push({
        kind: "context",
        left: line(oldLines, op.oldIndex),
        right: line(newLines, op.newIndex),
      });
    }
  }
  flush();
  return rows;
}

export function lineDiff(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const ids = new Map<string, number>();
  const intern = (lines: readonly string[], from: number, to: number): Int32Array =>
    Int32Array.from(lines.slice(from, to), (text) => {
      let id = ids.get(text);
      if (id === undefined) {
        id = ids.size;
        ids.set(text, id);
      }
      return id;
    });
  const middle =
    myers(intern(oldLines, start, oldEnd), intern(newLines, start, newEnd)) ??
    fallbackKinds(oldEnd - start, newEnd - start);

  const ops: DiffOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  const push = (kind: DiffOpKind): void => {
    ops.push({ kind, oldIndex, newIndex });
    if (kind !== "insert") oldIndex++;
    if (kind !== "delete") newIndex++;
  };
  for (let i = 0; i < start; i++) push("equal");
  middle.forEach(push);
  while (oldIndex < oldLines.length) push("equal");
  return ops;
}

export function wordRanges(
  before: string,
  after: string,
): { left: TextRange[]; right: TextRange[] } {
  const oldTokens = tokenize(before);
  const newTokens = tokenize(after);
  const left: TextRange[] = [];
  const right: TextRange[] = [];
  const mark = (ranges: TextRange[], start: number, token: string): void => {
    const last = ranges[ranges.length - 1];
    if (last && last.end === start) last.end += token.length;
    else ranges.push({ start, end: start + token.length });
  };
  let oldOffset = 0;
  let newOffset = 0;
  for (const op of lineDiff(oldTokens, newTokens)) {
    if (op.kind !== "insert") {
      const token = oldTokens[op.oldIndex];
      if (op.kind === "delete") mark(left, oldOffset, token);
      oldOffset += token.length;
    }
    if (op.kind !== "delete") {
      const token = newTokens[op.newIndex];
      if (op.kind === "insert") mark(right, newOffset, token);
      newOffset += token.length;
    }
  }
  return { left, right };
}

export function foldRows(
  rows: readonly { kind: string }[],
  expanded: ReadonlySet<number> = new Set(),
): FoldItem[] {
  const items: FoldItem[] = [];
  const pushRows = (from: number, to: number): void => {
    for (let index = from; index < to; index++) items.push({ kind: "row", index });
  };
  let index = 0;
  while (index < rows.length) {
    if (rows[index].kind !== "context") {
      items.push({ kind: "row", index });
      index++;
      continue;
    }
    let end = index;
    while (end < rows.length && rows[end].kind === "context") end++;
    const keepBefore = index === 0 ? 0 : FOLD_CONTEXT;
    const keepAfter = end === rows.length ? 0 : FOLD_CONTEXT;
    const foldStart = index + keepBefore;
    const foldEnd = end - keepAfter;
    if (foldEnd - foldStart >= MIN_FOLDED_ROWS && !expanded.has(foldStart)) {
      pushRows(index, foldStart);
      items.push({ kind: "fold", start: foldStart, end: foldEnd });
      pushRows(foldEnd, end);
    } else {
      pushRows(index, end);
    }
    index = end;
  }
  return items;
}

export function unifiedRows(rows: readonly DiffRow[]): UnifiedRow[] {
  const result: UnifiedRow[] = [];
  let added: UnifiedRow[] = [];
  const unified = (
    kind: UnifiedRowKind,
    line: DiffLine,
    oldNumber: number | null,
    newNumber: number | null,
  ): UnifiedRow => ({
    kind,
    oldNumber,
    newNumber,
    text: line.text,
    ...(line.changes ? { changes: line.changes } : {}),
  });
  for (const row of rows) {
    if (row.kind === "context" && row.left && row.right) {
      result.push(...added, unified("context", row.left, row.left.number, row.right.number));
      added = [];
      continue;
    }
    if (row.left) result.push(unified("deleted", row.left, row.left.number, null));
    if (row.right) added.push(unified("added", row.right, null, row.right.number));
  }
  result.push(...added);
  return result;
}

function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

function sideText(side: SideContent): string | null {
  return side.kind === "text" ? side.text : null;
}

function fallbackKinds(deletes: number, inserts: number): DiffOpKind[] {
  return [
    ...Array<DiffOpKind>(deletes).fill("delete"),
    ...Array<DiffOpKind>(inserts).fill("insert"),
  ];
}

function myers(a: Int32Array, b: Int32Array): DiffOpKind[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= Math.min(max, MAX_EDIT_DISTANCE); d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): DiffOpKind[] {
  const kinds: DiffOpKind[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const band = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && band[k - 1 + d] < band[k + 1 + d]) ? k + 1 : k - 1;
    const prevX = band[prevK + d];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      kinds.push("equal");
      x--;
      y--;
    }
    kinds.push(x === prevX ? "insert" : "delete");
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    kinds.push("equal");
    x--;
    y--;
  }
  return kinds.reverse();
}
