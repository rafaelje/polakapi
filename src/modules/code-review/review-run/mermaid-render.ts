import type { Mermaid } from "mermaid";
import type { RenderMermaid } from "./report-document";

let ready: Promise<Mermaid> | null = null;
let counter = 0;

function loadMermaid(): Promise<Mermaid> {
  ready ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
    return mermaid;
  });
  return ready;
}

export const renderMermaid: RenderMermaid = async (source) => {
  const mermaid = await loadMermaid();
  const { svg } = await mermaid.render(`polakapi-mermaid-${++counter}`, source);
  return svg;
};
