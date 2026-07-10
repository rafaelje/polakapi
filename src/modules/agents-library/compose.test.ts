import { describe, expect, it } from "vitest";

import { bracketedPaste, composeAgentText } from "./compose";
import type { AgentDef } from "./types";

const ESC = String.fromCharCode(0x1b);

function agent(files: { title: string; content: string }[]): AgentDef {
  return {
    id: "a1",
    name: "test",
    description: "",
    files: files.map((f, i) => ({ id: `f${i}`, title: f.title, content: f.content })),
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("composeAgentText", () => {
  it("returns trimmed content of the sole file with no header", () => {
    const out = composeAgentText(agent([{ title: "only.md", content: "  hello world  \n" }]));
    expect(out).toBe("hello world");
  });

  it("prefixes each file with a title comment when multiple files", () => {
    const out = composeAgentText(
      agent([
        { title: "a.md", content: "alpha" },
        { title: "b.md", content: "beta" },
      ]),
    );
    expect(out).toBe("<!-- a.md -->\nalpha\n\n<!-- b.md -->\nbeta");
  });

  it("trims each file's content in multi-file mode", () => {
    const out = composeAgentText(
      agent([
        { title: "a.md", content: "  alpha  \n" },
        { title: "b.md", content: "\nbeta\n" },
      ]),
    );
    expect(out).toBe("<!-- a.md -->\nalpha\n\n<!-- b.md -->\nbeta");
  });

  it("returns empty string when the agent has no files", () => {
    expect(composeAgentText(agent([]))).toBe("");
  });
});

describe("bracketedPaste", () => {
  it("wraps the text with the ESC-prefixed paste markers", () => {
    const out = bracketedPaste("hi");
    // Assert the exact bytes — a literal `[200~` (no ESC) would break CLIs.
    expect(out).toBe(`${ESC}[200~hi${ESC}[201~`);
    // Byte 0 is the opening ESC; byte at (length - 6) is the closing ESC.
    expect(out.charCodeAt(0)).toBe(0x1b);
    expect(out.charCodeAt(out.length - 6)).toBe(0x1b);
    expect(out.length).toBe(14); // 6 + 2 + 6
  });

  it("preserves multi-line payload inside the markers", () => {
    const payload = "line1\nline2\nline3";
    const out = bracketedPaste(payload);
    expect(out.startsWith(`${ESC}[200~`)).toBe(true);
    expect(out.endsWith(`${ESC}[201~`)).toBe(true);
    expect(out.slice(6, -6)).toBe(payload);
  });
});
