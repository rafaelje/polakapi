export type ToastVariant = "error" | "info" | "success" | "warning";

const HOST_ID = "toast-host";
const DEFAULT_DURATION_MS = 4500;

function ensureHost(): HTMLElement {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    document.body.append(host);
  }
  return host;
}

export function showToast(message: string, variant: ToastVariant = "info"): void {
  const host = ensureHost();
  const node = document.createElement("div");
  node.className = `toast toast-${variant}`;
  node.textContent = message;
  host.append(node);

  // Trigger CSS transition on next frame
  requestAnimationFrame(() => node.classList.add("visible"));

  const remove = (): void => {
    node.classList.remove("visible");
    node.addEventListener("transitionend", () => node.remove(), { once: true });
    // Fallback in case transitionend doesn't fire (e.g., display:none somewhere up the tree)
    setTimeout(() => node.remove(), 600);
  };
  setTimeout(remove, DEFAULT_DURATION_MS);
  node.addEventListener("click", remove);
}
