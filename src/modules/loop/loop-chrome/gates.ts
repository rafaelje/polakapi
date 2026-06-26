export function renderLoading(): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "loop-gate";
  const p = document.createElement("p");
  p.className = "loop-gate-msg loop-gate-muted";
  p.textContent = "loading…";
  wrap.appendChild(p);
  return wrap;
}

export function renderNoProjectGate(): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "loop-gate";
  const h = document.createElement("h2");
  h.className = "loop-gate-title";
  h.textContent = "Pick a project first";
  const p = document.createElement("p");
  p.className = "loop-gate-msg";
  p.textContent =
    "/loop operates on the workspace's active project. Open the main window and select one to start.";
  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "loop-btn loop-btn-primary";
  cta.textContent = "Open workspace";
  cta.addEventListener("click", () => {
    void focusMainWindow();
  });
  wrap.append(h, p, cta);
  return wrap;
}

export function renderInvalidPathGate(name: string, path: string): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "loop-gate loop-gate-error";
  const h = document.createElement("h2");
  h.className = "loop-gate-title";
  h.textContent = "Invalid path";
  const p = document.createElement("p");
  p.className = "loop-gate-msg";
  p.textContent = `Project "${name}" points to a path that does not exist or is not accessible.`;
  const code = document.createElement("code");
  code.className = "loop-gate-path";
  code.textContent = path;
  const hint = document.createElement("p");
  hint.className = "loop-gate-msg loop-gate-muted";
  hint.textContent =
    "Go back to the workspace and fix the path (right click → change path) before using /loop.";
  wrap.append(h, p, code, hint);
  return wrap;
}

async function focusMainWindow(): Promise<void> {
  try {
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const all = await getAllWebviewWindows();
    const main = all.find((w) => w.label === "main") ?? all.find((w) => w.label !== "loop");
    if (main) {
      await main.unminimize();
      await main.show();
      await main.setFocus();
    }
  } catch (err) {
    console.error("Could not focus main window from /loop gate", err);
  }
}
