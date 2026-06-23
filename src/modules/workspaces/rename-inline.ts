export interface InlineRenameOptions {
  target: HTMLElement;
  initialValue: string;
  placeholder?: string;
}

/**
 * Swaps `target`'s text content with a focused `<input>` and resolves with the
 * new value on Enter / blur (commit) or `null` on Escape (cancel). The DOM is
 * restored to its original state — no leftover input element, no listeners.
 */
export function startInlineRename(opts: InlineRenameOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const { target, initialValue, placeholder } = opts;
    const previousText = target.textContent ?? "";
    target.textContent = "";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "ws-rename-input";
    input.value = initialValue;
    if (placeholder) input.placeholder = placeholder;
    target.append(input);

    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      input.removeEventListener("keydown", onKey);
      input.removeEventListener("blur", onBlur);
      input.remove();
      // Restore the previous text so callers can patch it after persisting.
      target.textContent = previousText;
      resolve(value);
    };

    const commit = (): void => {
      const value = input.value.trim();
      finish(value.length === 0 ? null : value);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    };
    const onBlur = (): void => {
      commit();
    };

    input.addEventListener("keydown", onKey);
    input.addEventListener("blur", onBlur);

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}
