type ElementCtor<T extends Element> = new () => T;

/**
 * Returns the element with the given id, asserting it exists and matches the
 * expected constructor. Throws a descriptive error instead of returning `null`
 * or silently mis-casting (the `as HTMLDivElement` foot-gun).
 */
export function requireById<T extends Element = HTMLElement>(id: string, ctor?: ElementCtor<T>): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Required element #${id} not found in DOM`);
  if (ctor && !(el instanceof ctor)) {
    throw new Error(`Element #${id} is not a ${ctor.name}`);
  }
  return el as unknown as T;
}

export function requireQuery<T extends Element = HTMLElement>(
  selector: string,
  ctor?: ElementCtor<T>,
): T {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Required element ${selector} not found in DOM`);
  if (ctor && !(el instanceof ctor)) {
    throw new Error(`Element ${selector} is not a ${ctor.name}`);
  }
  return el as unknown as T;
}
