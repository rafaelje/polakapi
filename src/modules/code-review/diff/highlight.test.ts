import { describe, expect, it } from "vitest";
import { highlightFile, splitHighlightedLines, type HighlightedLine } from "./highlight";

const plain = (line: HighlightedLine): string => line.map((segment) => segment.text).join("");
const classesOf = (line: HighlightedLine, text: string): string[] | undefined =>
  line.find((segment) => segment.text.includes(text))?.classes;

describe("highlightFile", () => {
  it("keeps a multi-line comment highlighted on every line it spans", () => {
    const lines = highlightFile("const a = 1;\n/* first\n   second */\nlet b = 2;\n", "src/a.ts");

    expect(lines.map(plain)).toEqual(["const a = 1;", "/* first", "   second */", "let b = 2;"]);
    expect(classesOf(lines[1], "first")).toEqual(["hljs-comment"]);
    expect(classesOf(lines[2], "second")).toEqual(["hljs-comment"]);
    expect(classesOf(lines[3], "let")).toEqual(["hljs-keyword"]);
  });

  it("returns the original characters, never HTML entities", () => {
    const lines = highlightFile('if (a < b && c > "d") {}\n', "main.rs");

    expect(lines.map(plain)).toEqual(['if (a < b && c > "d") {}']);
  });

  it("falls back to plain text for unknown extensions", () => {
    const lines = highlightFile("<b>not html</b>\nsecond", "notes.unknownext");

    expect(lines).toEqual([
      [{ text: "<b>not html</b>", classes: [] }],
      [{ text: "second", classes: [] }],
    ]);
  });

  it("keeps empty lines as empty entries", () => {
    expect(highlightFile("a\n\nb", "x.txt").map(plain)).toEqual(["a", "", "b"]);
  });
});

describe("splitHighlightedLines", () => {
  it("reopens nested spans on the following line", () => {
    const html = '<span class="a">x<span class="b">y\nz</span>w</span>\nv';

    expect(splitHighlightedLines(html)).toEqual([
      [
        { text: "x", classes: ["a"] },
        { text: "y", classes: ["a", "b"] },
      ],
      [
        { text: "z", classes: ["a", "b"] },
        { text: "w", classes: ["a"] },
      ],
      [{ text: "v", classes: [] }],
    ]);
  });

  it("decodes the entities highlight.js emits", () => {
    expect(splitHighlightedLines("&lt;a&gt; &amp; &quot;b&quot; &#x27;c&#x27;")).toEqual([
      [{ text: `<a> & "b" 'c'`, classes: [] }],
    ]);
  });
});
