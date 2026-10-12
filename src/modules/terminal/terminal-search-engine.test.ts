import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  searchTerminalLines,
  snapshotSearchLines,
  type SearchOptions,
} from "./terminal-search-engine";

vi.hoisted(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
const terminals: Terminal[] = [];
const defaults: SearchOptions = { regex: false, caseSensitive: false, wholeWord: false };

async function terminal(text: string, cols = 80): Promise<Terminal> {
  const term = new Terminal({ cols, rows: 10, scrollback: 5000, allowProposedApi: true });
  terminals.push(term);
  await new Promise<void>((resolve) => term.write(text, resolve));
  return term;
}

function find(term: Terminal, query: string, options: Partial<SearchOptions> = {}) {
  return searchTerminalLines({
    lines: snapshotSearchLines(term),
    query,
    options: { ...defaults, ...options },
  });
}

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
});

describe("terminal buffer search", () => {
  it("finds history outside the viewport and excludes evicted output", async () => {
    const term = await terminal("evicted\r\n" + "line\r\n".repeat(5500) + "latest");
    expect(term.buffer.active.baseY).toBe(5000);
    expect(find(term, "evicted").matches).toHaveLength(0);
    expect(find(term, "line").matches.length / 2).toBe(5009);
    expect(find(term, "latest").matches.length / 2).toBe(1);
  });

  it("counts dense buffers without a highlight cap", async () => {
    const term = await terminal(("a".repeat(80) + "\r\n").repeat(5010));
    const start = performance.now();
    const result = find(term, "a");
    expect(result.matches.length / 2).toBe(5009 * 80);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it("maps wrapped Unicode and combining characters to cells", async () => {
    const term = await terminal("123456789界e\u0301😀end", 10);
    expect(Array.from(find(term, "9界e\u0301😀").matches)).toEqual([8, 14]);
    expect(Array.from(find(term, "end").matches)).toEqual([14, 17]);
    expect(find(term, "9 界").matches).toHaveLength(0);
  });

  it("does not join hard line breaks and recomputes after reflow", async () => {
    const term = await terminal("abcdefghij\r\nsecond", 6);
    expect(Array.from(find(term, "defgh").matches)).toEqual([3, 8]);
    expect(find(term, "jsecond").matches).toHaveLength(0);
    term.resize(12, 10);
    expect(Array.from(find(term, "defgh").matches)).toEqual([3, 8]);
  });

  it("combines case, whole-word and regex options without changing regex semantics", async () => {
    const term = await terminal("hell HELLO hello shell hello_world élève élève2 42 A");
    expect(find(term, "hello").matches.length / 2).toBe(3);
    expect(find(term, "hello", { caseSensitive: true, wholeWord: true }).matches.length / 2).toBe(
      1,
    );
    expect(find(term, "élève", { wholeWord: true }).matches.length / 2).toBe(1);
    expect(
      find(term, "[A-Z]+", { regex: true, caseSensitive: true, wholeWord: true }).matches.length /
        2,
    ).toBe(2);
    expect(find(term, "\\D+", { regex: true }).matches.length / 2).toBe(3);
    expect(find(term, ".*").matches).toHaveLength(0);
  });

  it("handles empty, malformed, unmatched and zero-length expressions", async () => {
    const term = await terminal("abc 😀");
    for (const query of ["", "missing", "^", "(?=.)", "$"]) {
      expect(find(term, query, { regex: true }).matches).toHaveLength(0);
    }
    expect(find(term, "(", { regex: true }).error).toBe("Invalid regular expression");
    expect(Array.from(find(term, "(?=a)|bc", { regex: true }).matches)).toEqual([1, 3]);
  });

  it("searches only the active alternate buffer", async () => {
    const term = await terminal("shell history\r\n\x1b[?1049h\x1b[Heditor content");
    expect(find(term, "history").matches).toHaveLength(0);
    expect(find(term, "editor").matches.length / 2).toBe(1);
    await new Promise<void>((resolve) => term.write("\x1b[?1049l", resolve));
    expect(find(term, "history").matches.length / 2).toBe(1);
    expect(find(term, "editor").matches).toHaveLength(0);
  });
});
