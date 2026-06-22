import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriInvoke,
}));

const showToast = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({
  showToast,
}));

import { invoke, InvokeError } from "./invoke";

describe("invoke wrapper", () => {
  beforeEach(() => {
    tauriInvoke.mockReset();
    showToast.mockReset();
  });

  it("returns the underlying result on success", async () => {
    tauriInvoke.mockResolvedValueOnce("hello");
    await expect(invoke<string>("greet", { name: "world" })).resolves.toBe("hello");
    expect(showToast).not.toHaveBeenCalled();
  });

  it("wraps thrown errors and shows a toast by default", async () => {
    tauriInvoke.mockRejectedValueOnce("pty gone");
    const promise = invoke("pty_write", { id: "x" });
    await expect(promise).rejects.toBeInstanceOf(InvokeError);
    await promise.catch((err: unknown) => {
      const e = err as InvokeError;
      expect(e.command).toBe("pty_write");
      expect(e.cause).toBe("pty gone");
    });
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("pty_write"), "error");
  });

  it("respects toastOnError=false", async () => {
    tauriInvoke.mockRejectedValueOnce(new Error("boom"));
    await expect(invoke("pty_resize", {}, { toastOnError: false })).rejects.toBeInstanceOf(
      InvokeError,
    );
    expect(showToast).not.toHaveBeenCalled();
  });

  it("uses errorMessage override in toast", async () => {
    tauriInvoke.mockRejectedValueOnce(new Error("nope"));
    await expect(invoke("pty_spawn", {}, { errorMessage: "Spawn failed" })).rejects.toBeInstanceOf(
      InvokeError,
    );
    expect(showToast).toHaveBeenCalledWith("Spawn failed", "error");
  });
});
