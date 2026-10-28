export function el<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function renderEmpty(container: HTMLElement, message: string, error = false): void {
  const className = error ? "code-review-empty code-review-error" : "code-review-empty";
  container.replaceChildren(el("p", className, message));
}
