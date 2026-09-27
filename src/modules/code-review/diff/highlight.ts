import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { splitLines, type TextRange } from "./diff-model";
import { languageForPath } from "./language";

export interface HighlightSegment {
  text: string;
  classes: string[];
}

export type HighlightedLine = HighlightSegment[];

export interface MarkedSegment extends HighlightSegment {
  changed: boolean;
}

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  makefile,
  markdown,
  php,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
};

export function highlightFile(text: string, path: string): HighlightedLine[] {
  const lines = splitLines(text);
  const language = languageForPath(path).highlight;
  if (!language || !hljs.getLanguage(language)) return lines.map(plainLine);
  const normalized = lines.join("\n");
  try {
    const html = hljs.highlight(normalized, { language, ignoreIllegals: true }).value;
    return splitHighlightedLines(html);
  } catch {
    return lines.map(plainLine);
  }
}

export function plainLine(text: string): HighlightedLine {
  return text ? [{ text, classes: [] }] : [];
}

export function splitHighlightedLines(html: string): HighlightedLine[] {
  const lines: HighlightedLine[] = [[]];
  const stack: string[][] = [];
  const classes = (): string[] => stack.flat();
  const pushText = (raw: string): void => {
    const parts = raw.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e]).split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, classes: classes() });
    });
  };
  const tag = /<span class="([^"]*)">|<\/span>/g;
  let cursor = 0;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    pushText(html.slice(cursor, match.index));
    if (match[1] === undefined) stack.pop();
    else stack.push(match[1].split(" ").filter(Boolean));
    cursor = tag.lastIndex;
  }
  pushText(html.slice(cursor));
  return lines;
}

export function markChanges(line: HighlightedLine, ranges: readonly TextRange[]): MarkedSegment[] {
  const marked: MarkedSegment[] = [];
  let offset = 0;
  for (const segment of line) {
    const end = offset + segment.text.length;
    const cuts = new Set([offset, end]);
    for (const range of ranges) {
      if (range.start > offset && range.start < end) cuts.add(range.start);
      if (range.end > offset && range.end < end) cuts.add(range.end);
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < points.length; i++) {
      const from = points[i];
      marked.push({
        text: segment.text.slice(from - offset, points[i + 1] - offset),
        classes: segment.classes,
        changed: ranges.some((range) => range.start <= from && from < range.end),
      });
    }
    offset = end;
  }
  return marked;
}
