// Shared row/control factories for the settings window, so every section
// renders the same way regardless of which module builds it.

export function settingsRow(
  group: HTMLElement,
  title: string,
  description: string,
): HTMLDivElement {
  const element = document.createElement("section");
  element.className = "settings-row";
  const copy = document.createElement("div");
  const label = document.createElement("h3");
  label.textContent = title;
  const help = document.createElement("p");
  help.textContent = description;
  copy.append(label, help);
  const controls = document.createElement("div");
  controls.className = "settings-controls";
  element.append(copy, controls);
  group.append(element);
  return controls;
}

export function settingsToggle(
  title: string,
  checked: boolean,
  change: (checked: boolean) => void,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.role = "switch";
  input.className = "settings-switch";
  input.checked = checked;
  input.setAttribute("aria-label", title);
  input.addEventListener("change", () => change(input.checked));
  return input;
}

export function settingsSelect(
  label: string,
  options: ReadonlyArray<readonly [string, string]>,
  value: string,
  change: (value: string) => void,
): HTMLSelectElement {
  const select = document.createElement("select");
  select.setAttribute("aria-label", label);
  for (const [optionValue, optionLabel] of options) {
    select.add(new Option(optionLabel, optionValue));
  }
  select.value = value;
  select.addEventListener("change", () => change(select.value));
  return select;
}

export function settingsNumber(
  label: string,
  value: number,
  bounds: { min: number; max: number },
  change: (value: number) => void,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "settings-number";
  input.setAttribute("aria-label", label);
  input.min = String(bounds.min);
  input.max = String(bounds.max);
  setSettingsNumber(input, value);
  input.addEventListener("change", () => {
    // Number("") is 0, so a cleared field has to be caught before converting.
    const raw = input.value.trim();
    const parsed = raw === "" ? Number.NaN : Number(raw);
    // A cleared or nonsense field falls back to the value already in effect
    // rather than writing NaN into the store.
    const next = Number.isFinite(parsed)
      ? Math.min(bounds.max, Math.max(bounds.min, Math.round(parsed)))
      : Number(input.dataset.current);
    setSettingsNumber(input, next);
    change(next);
  });
  return input;
}

/** Shows a value set from outside the control and makes it the fallback. */
export function setSettingsNumber(input: HTMLInputElement, value: number): void {
  input.value = String(value);
  input.dataset.current = String(value);
}
