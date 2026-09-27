import type { DiffLine, DiffRow, UnifiedRow } from "./diff-model";
import { languageForPath } from "./language";

export type ReferenceSide = "before" | "after";

export interface LineSelection {
  side: ReferenceSide;
  lines: DiffLine[];
}

export function sideSelection(
  rows: readonly DiffRow[],
  side: "left" | "right",
  from: number,
  to: number,
): LineSelection | null {
  const lines = rowsBetween(rows, from, to).flatMap((row) => {
    const line = side === "left" ? row.left : row.right;
    return line ? [{ number: line.number, text: line.text }] : [];
  });
  return lines.length > 0 ? { side: side === "left" ? "before" : "after", lines } : null;
}

export function unifiedSelection(
  rows: readonly UnifiedRow[],
  from: number,
  to: number,
): LineSelection | null {
  const selected = rowsBetween(rows, from, to);
  if (selected.length === 0) return null;
  if (selected.every((row) => row.kind === "deleted")) {
    return {
      side: "before",
      lines: selected.map((row) => ({ number: row.oldNumber ?? 0, text: row.text })),
    };
  }
  return {
    side: "after",
    lines: selected.flatMap((row) =>
      row.newNumber === null ? [] : [{ number: row.newNumber, text: row.text }],
    ),
  };
}

export function formatReference(
  path: string,
  selection: LineSelection,
  base?: string | null,
): string {
  const numbers = selection.lines.map((line) => line.number);
  const start = Math.min(...numbers);
  const end = Math.max(...numbers);
  const range = start === end ? `${start}` : `${start}-${end}`;
  const label = selection.side === "after" ? "after" : base ? `before, ${base}` : "before";
  const body = selection.lines.map((line) => line.text).join("\n");
  const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const language = languageForPath(path).fence;
  return `${path}:${range} (${label})\n${fence}${language}\n${body}\n${fence}\n`;
}

function rowsBetween<T>(rows: readonly T[], from: number, to: number): T[] {
  return rows.slice(Math.min(from, to), Math.max(from, to) + 1);
}
