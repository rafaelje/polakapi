import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { showToast } from "./toast";

export class InvokeError extends Error {
  constructor(
    readonly command: string,
    readonly cause: unknown,
  ) {
    super(`invoke "${command}" failed: ${stringifyCause(cause)}`);
    this.name = "InvokeError";
  }
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

export interface InvokeOptions {
  /**
   * Show a toast on failure. Defaults to true. Set false for high-frequency
   * commands (e.g., per-keystroke writes) where you handle errors yourself.
   */
  toastOnError?: boolean;
  /** Custom message shown in the toast (falls back to a generic one). */
  errorMessage?: string;
}

/**
 * Wraps tauriInvoke with consistent error logging and optional user feedback.
 * Always rejects with InvokeError so callers can branch on `.cause` if needed.
 */
export async function invoke<T>(
  command: string,
  args?: InvokeArgs,
  opts: InvokeOptions = {},
): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (cause) {
    const err = new InvokeError(command, cause);
    console.error(err);
    if (opts.toastOnError !== false) {
      showToast(opts.errorMessage ?? `Command "${command}" failed`, "error");
    }
    throw err;
  }
}
