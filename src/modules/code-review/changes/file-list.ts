import { fileKey, type ChangesGroupView } from "../code-review-model";
import { el } from "../dom";
import type { ChangedFile, ChangeStatus } from "../types";

const STATUS_LETTERS: Readonly<Record<ChangeStatus, string>> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "C",
};

export function renderFileList(
  container: HTMLElement,
  groups: readonly ChangesGroupView[],
  selectedKey: string | null,
): void {
  const sections = groups.map((group) => {
    const section = el("section", "code-review-group");
    section.dataset.group = group.group;
    const heading = el("h2", "code-review-group-title");
    heading.append(
      el("span", undefined, group.label),
      el("span", "code-review-group-count", String(group.count)),
    );
    section.append(heading);
    if (group.count === 0) {
      section.append(el("p", "code-review-group-empty", "none"));
    }
    for (const file of group.files) {
      section.append(createFileRow(file, fileKey(file) === selectedKey));
    }
    return section;
  });
  container.replaceChildren(...sections);
}

export function statusLetter(status: ChangeStatus): string {
  return STATUS_LETTERS[status];
}

function createFileRow(file: ChangedFile, selected: boolean): HTMLButtonElement {
  const row = el("button", `code-review-file${selected ? " is-selected" : ""}`);
  row.type = "button";
  row.dataset.key = fileKey(file);
  row.title = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
  row.setAttribute("aria-selected", String(selected));

  const status = el("span", "code-review-status", statusLetter(file.status));
  status.dataset.status = file.status;
  status.title = file.status;

  const name = el("span", "code-review-file-name");
  const slash = file.path.lastIndexOf("/");
  name.append(el("span", "code-review-file-base", file.path.slice(slash + 1)));
  const dir = file.path.slice(0, slash + 1);
  if (dir) name.append(el("span", "code-review-file-dir", dir));
  if (file.originalPath) {
    name.append(el("span", "code-review-file-source", `from ${file.originalPath}`));
  }

  row.append(status, name, createCounts(file));
  return row;
}

function createCounts(file: ChangedFile): HTMLSpanElement {
  const counts = el("span", "code-review-counts");
  if (file.binary) {
    counts.append(el("span", "code-review-binary", "binary"));
    return counts;
  }
  counts.append(
    el("span", "code-review-insertions", `+${file.insertions}`),
    el("span", "code-review-deletions", `-${file.deletions}`),
  );
  return counts;
}
