import { describe, expect, it } from "vitest";
import { buildReportDocument } from "./report-document";

const svg = (source: string): Promise<string> =>
  Promise.resolve(`<svg data-source="${source.length}"></svg>`);

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("buildReportDocument", () => {
  it("draws every Mermaid block before the frame shows it", async () => {
    const html = `<html><body>
      <pre class="mermaid">graph TD; A-->B</pre>
      <div class="mermaid">erDiagram USER ||--o{ ORDER : places</div>
      <pre><code class="language-mermaid">graph LR; C-->D</code></pre>
      <h2>Big O</h2><p>O(n)</p></body></html>`;

    const doc = parse(await buildReportDocument(html, "1.1-login.html", svg));

    expect(doc.querySelectorAll(".polakapi-mermaid svg")).toHaveLength(3);
    expect(doc.querySelector(".mermaid, code.language-mermaid")).toBeNull();
    expect(doc.body.textContent).toContain("O(n)");
  });

  it("keeps the diagram source and the reason when Mermaid cannot draw it", async () => {
    const failing = (): Promise<string> => Promise.reject(new Error("Parse error on line 1"));

    const doc = parse(
      await buildReportDocument('<pre class="mermaid">graph ???</pre>', "1.1-a.html", failing),
    );

    expect(doc.body.textContent).toContain(
      "Mermaid could not draw this diagram: Parse error on line 1",
    );
    expect(doc.querySelector(".polakapi-mermaid pre")?.textContent).toBe("graph ???");
  });

  it("drops scripts, frames, handlers and script URLs", async () => {
    const html = `<html><head><script src="https://cdn/mermaid.js"></script>
      <meta http-equiv="refresh" content="0;url=https://x"><base href="https://x/"></head>
      <body onload="steal()"><a href="javascript:steal()">x</a><iframe src="https://x"></iframe>
      <img src="data:image/png;base64,AAAA" onerror="steal()"></body></html>`;

    const out = await buildReportDocument(html, "index.html", svg);
    const doc = parse(out);

    expect(doc.querySelector("script, iframe, base, meta[http-equiv]")).toBeNull();
    expect(out).not.toMatch(/onload|onerror|javascript:/i);
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("shows pseudo-code files as escaped plain text", async () => {
    const out = await buildReportDocument("# 1.1 login\nif <x> then", "1.1-login.md", svg);
    const doc = parse(out);

    expect(doc.body.textContent).toBe("# 1.1 login\nif <x> then");
    expect(doc.body.querySelector("x")).toBeNull();
  });
});
