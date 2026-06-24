import { invoke } from "../../shared/tauri/invoke";
import type { PathValidation } from "./state/types";

/**
 * Validates a filesystem path via the `fs_validate_path` Rust command.
 *
 * Maps the stable error strings emitted by the backend ("not_found",
 * "not_directory", "not_readable", "unknown:<msg>") into a discriminated
 * union the UI can branch on. Never throws — every failure is surfaced as
 * `{ ok: false }`.
 */
export async function validatePath(path: string): Promise<PathValidation> {
  try {
    await invoke<void>("fs_validate_path", { path }, { toastOnError: false });
    return { ok: true };
  } catch (cause) {
    const message = extractMessage(cause);
    if (message === "not_found") return { ok: false, reason: "not_found" };
    if (message === "not_directory") return { ok: false, reason: "not_directory" };
    if (message === "not_readable") return { ok: false, reason: "not_readable" };
    if (message.startsWith("unknown:")) {
      return { ok: false, reason: "unknown", detail: message.slice("unknown:".length) };
    }
    return { ok: false, reason: "unknown", detail: message };
  }
}

/**
 * Maps a failed PathValidation into a human-readable message suitable for a
 * toast. Lives next to `validatePath` so both stay in sync.
 */
export function formatPathError(validation: Extract<PathValidation, { ok: false }>): string {
  switch (validation.reason) {
    case "not_found":
      return "Path does not exist.";
    case "not_directory":
      return "Selected entry is not a directory.";
    case "not_readable":
      return "Path is not readable.";
    default:
      return validation.detail
        ? `Path error: ${validation.detail}`
        : "Path could not be validated.";
  }
}

function extractMessage(cause: unknown): string {
  if (cause instanceof Error) {
    // InvokeError wraps the raw cause; prefer that.
    const innerCause = (cause as Error & { cause?: unknown }).cause;
    if (typeof innerCause === "string") return innerCause;
    if (innerCause instanceof Error) return innerCause.message;
    return cause.message;
  }
  if (typeof cause === "string") return cause;
  return "";
}
