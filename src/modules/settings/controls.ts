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
  input.value = String(value);
  input.addEventListener("change", () => {
    const parsed = Number(input.value);
    // A cleared or nonsense field falls back to the value already in effect
    // rather than writing NaN into the store.
    const next = Number.isFinite(parsed)
      ? Math.min(bounds.max, Math.max(bounds.min, Math.round(parsed)))
      : value;
    input.value = String(next);
    change(next);
  });
  return input;
}
