import type { CodeReviewKeyAction } from "../code-review-model";
import type { ChangedFile } from "../types";

export interface DiscardStep {
  armed: string | null;
  confirmed: string | null;
}

export function discardStep(
  armed: string | null,
  selected: string | null,
  action: CodeReviewKeyAction | null,
): DiscardStep {
  if (action !== "discard" || selected === null) return { armed: null, confirmed: null };
  if (armed === selected) return { armed: null, confirmed: selected };
  return { armed: selected, confirmed: null };
}

export function discardPaths(file: ChangedFile): string[] {
  return file.originalPath ? [file.path, file.originalPath] : [file.path];
}
