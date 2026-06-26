/**
 * Normalize an unknown thrown value into a human-readable string suitable
 * for status messages, toasts, and console logs.
 *
 * Priority: `Error.message` > raw string > JSON.stringify > `String(err)`.
 * The JSON fallback covers structured errors thrown from Tauri commands;
 * the `String()` last resort handles cyclic objects that throw on stringify.
 */
export function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
