export type RenderMermaid = (source: string) => Promise<string>;

const INERT_ELEMENTS = "script, iframe, frame, object, embed, base, meta[http-equiv]";

const PLAIN_STYLE =
  "body{margin:0;padding:16px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;" +
  "white-space:pre-wrap;overflow-wrap:anywhere;color:#1f2328;background:#fff}";

export function isMarkdownReport(file: string): boolean {
  return file.toLowerCase().endsWith(".md");
}

/**
 * Turns a report file into the `srcdoc` of a sandboxed frame that runs no
 * scripts: Mermaid diagrams are drawn here beforehand, and anything that could
 * execute or navigate is dropped.
 */
export async function buildReportDocument(
  source: string,
  file: string,
  renderMermaid: RenderMermaid,
): Promise<string> {
  if (isMarkdownReport(file)) return plainDocument(source);
  const doc = new DOMParser().parseFromString(source, "text/html");
  for (const node of doc.querySelectorAll(INERT_ELEMENTS)) node.remove();
  for (const node of doc.querySelectorAll("*")) stripActiveAttributes(node);
  for (const block of mermaidBlocks(doc)) await drawDiagram(doc, block, renderMermaid);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function mermaidBlocks(doc: Document): Element[] {
  const blocks = new Set<Element>(doc.querySelectorAll("pre.mermaid, div.mermaid"));
  for (const code of doc.querySelectorAll("code.language-mermaid")) {
    blocks.add(code.closest("pre") ?? code);
  }
  return [...blocks];
}

function plainDocument(text: string): string {
  const doc = document.implementation.createHTMLDocument("");
  const meta = doc.createElement("meta");
  meta.setAttribute("charset", "utf-8");
  const style = doc.createElement("style");
  style.textContent = PLAIN_STYLE;
  doc.head.append(meta, style);
  doc.body.textContent = text;
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function stripActiveAttributes(node: Element): void {
  for (const { name, value } of Array.from(node.attributes)) {
    const lower = name.toLowerCase();
    const scriptUrl =
      /^\s*(javascript|vbscript|data):/i.test(value) && !isImageData(node, lower, value);
    if (lower.startsWith("on") || scriptUrl || lower === "srcdoc") node.removeAttribute(name);
  }
}

function isImageData(node: Element, attribute: string, value: string): boolean {
  return node.tagName === "IMG" && attribute === "src" && /^\s*data:image\//i.test(value);
}

async function drawDiagram(
  doc: Document,
  block: Element,
  renderMermaid: RenderMermaid,
): Promise<void> {
  const source = (block.textContent ?? "").trim();
  const figure = doc.createElement("div");
  figure.className = "polakapi-mermaid";
  try {
    figure.innerHTML = await renderMermaid(source);
  } catch (error) {
    const note = doc.createElement("p");
    note.textContent = `Mermaid could not draw this diagram: ${error instanceof Error ? error.message : String(error)}`;
    const code = doc.createElement("pre");
    code.textContent = source;
    figure.append(note, code);
  }
  block.replaceWith(figure);
}
