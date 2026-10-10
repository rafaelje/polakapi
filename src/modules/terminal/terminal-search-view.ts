import type { SearchOptions } from "./terminal-search-engine";

export class TerminalSearchView {
  readonly el = document.createElement("div");
  readonly input = document.createElement("input");
  readonly status = document.createElement("span");
  readonly options: SearchOptions = { regex: false, caseSensitive: false, wholeWord: false };
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;

  constructor(onChange: () => void, navigate: (direction: number) => void, close: () => void) {
    this.el.className = "terminal-search";
    this.el.hidden = true;
    this.el.setAttribute("role", "search");
    this.el.setAttribute("aria-label", "Search terminal");
    this.input.type = "text";
    this.input.placeholder = "Find in terminal";
    this.input.setAttribute("aria-label", "Find in terminal");
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.addEventListener("input", onChange);
    const field = document.createElement("div");
    field.className = "terminal-search-field";
    field.append(this.input);
    for (const [key, label, icon] of [
      ["regex", "Use regular expression", ".*"],
      ["caseSensitive", "Match case", "Aa"],
      ["wholeWord", "Match whole word", "ab"],
    ] as const) {
      const toggle = this.button(icon, label, () => {
        this.options[key] = !this.options[key];
        toggle.setAttribute("aria-pressed", String(this.options[key]));
        onChange();
      });
      toggle.setAttribute("aria-pressed", "false");
      if (key === "wholeWord") toggle.classList.add("terminal-search-word");
      field.append(toggle);
    }
    this.status.className = "terminal-search-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.previous = this.button("↑", "Previous match (Shift+Enter)", () => navigate(-1));
    this.next = this.button("↓", "Next match (Enter)", () => navigate(1));
    const controls = document.createElement("div");
    controls.className = "terminal-search-controls";
    controls.append(
      this.status,
      this.previous,
      this.next,
      this.button("×", "Close search (Escape)", close),
    );
    this.el.append(field, controls);
    this.update(0, 0);
  }

  update(index: number, count: number, message?: string): void {
    this.status.textContent = message ?? `${count ? index + 1 : 0}/${count}`;
    this.status.title = message ?? `${count} matches`;
    this.previous.disabled = this.next.disabled = count === 0;
    this.input.setAttribute("aria-invalid", String(!!message && message !== "Searching…"));
  }

  private button(text: string, label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", action);
    return button;
  }
}
