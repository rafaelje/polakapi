/**
 * DOM helpers for the workspaces drag-and-drop module. Owns the insertion
 * line element and the `.ws-drop-target` highlight so `drag-drop.ts` can
 * stay focused on event wiring.
 */

export type RowSelector = ".ws-project-row" | ".ws-workspace";

export interface VisualsHandle {
  showInsertionLine(
    container: HTMLElement,
    clientY: number,
    rowSelector: RowSelector,
    ignoreId: string,
  ): void;
  setDropTarget(el: HTMLElement | null): void;
  clear(): void;
}

export function createVisuals(): VisualsHandle {
  let insertionLine: HTMLElement | null = null;
  let dropTargetEl: HTMLElement | null = null;

  function showInsertionLine(
    container: HTMLElement,
    clientY: number,
    rowSelector: RowSelector,
    ignoreId: string,
  ): void {
    if (!insertionLine) {
      insertionLine = document.createElement("div");
      insertionLine.className = "ws-insertion-line";
    }
    const rect = container.getBoundingClientRect();
    const rows = Array.from(container.querySelectorAll<HTMLElement>(rowSelector));
    let topPx = container.scrollHeight;
    for (const row of rows) {
      if (datasetIdFor(row, rowSelector) === ignoreId) continue;
      const r = row.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      if (clientY < mid) {
        topPx = r.top - rect.top + container.scrollTop;
        break;
      }
    }
    container.style.position = container.style.position || "relative";
    insertionLine.style.top = `${topPx}px`;
    if (insertionLine.parentElement !== container) container.append(insertionLine);
  }

  function setDropTarget(el: HTMLElement | null): void {
    if (dropTargetEl === el) return;
    dropTargetEl?.classList.remove("ws-drop-target");
    dropTargetEl = el;
    dropTargetEl?.classList.add("ws-drop-target");
  }

  function clear(): void {
    insertionLine?.remove();
    insertionLine = null;
    dropTargetEl?.classList.remove("ws-drop-target");
    dropTargetEl = null;
  }

  return { showInsertionLine, setDropTarget, clear };
}

export function datasetIdFor(row: HTMLElement, selector: RowSelector): string | undefined {
  return selector === ".ws-project-row" ? row.dataset.projectId : row.dataset.workspaceId;
}

export function computeInsertionIndex(
  container: HTMLElement,
  clientY: number,
  rowSelector: RowSelector,
  ignoreId: string,
): number {
  const rows = Array.from(container.querySelectorAll<HTMLElement>(rowSelector)).filter(
    (row) => datasetIdFor(row, rowSelector) !== ignoreId,
  );
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    const mid = r.top + r.height / 2;
    if (clientY < mid) return i;
  }
  return rows.length;
}

export function currentOrder<T extends string>(
  container: HTMLElement,
  rowSelector: RowSelector,
): T[] {
  return Array.from(container.querySelectorAll<HTMLElement>(rowSelector))
    .map((row) => datasetIdFor(row, rowSelector))
    .filter((id): id is string => !!id) as T[];
}
