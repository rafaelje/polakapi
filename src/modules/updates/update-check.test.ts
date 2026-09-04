import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/tauri/invoke", () => ({ invoke: vi.fn() }));
vi.mock("../../shared/persistence/store", () => ({
  loadLayout: vi.fn(),
  queueSave: vi.fn(),
}));
vi.mock("../../shared/ui/toast", () => ({ showToast: vi.fn() }));

import { mountUpdateIndicator, type UpdateCheck, type UpdateIndicatorDeps } from "./update-check";

const newer: UpdateCheck = {
  currentVersion: "0.8.0",
  latestVersion: "0.9.0",
  updateAvailable: true,
  releaseUrl: "https://github.com/rafaelje/polakapi/releases/tag/v0.9.0",
};

function deps(overrides: Partial<UpdateIndicatorDeps> = {}) {
  const base = {
    check: vi.fn<() => Promise<UpdateCheck>>().mockResolvedValue(newer),
    openUrl: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
    loadDismissed: vi.fn<() => Promise<string | undefined>>().mockResolvedValue(undefined),
    saveDismissed: vi.fn<(version: string) => void>(),
    notify: vi.fn<(message: string) => void>(),
    initialDelayMs: 0,
    intervalMs: 60_000,
  };
  return { ...base, ...overrides };
}

describe("mountUpdateIndicator", () => {
  let host: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    host.remove();
  });

  it("shows the chip and notifies once when a newer release exists", async () => {
    const d = deps();
    const handle = mountUpdateIndicator(host, d);
    await vi.advanceTimersByTimeAsync(0);

    expect(host.hidden).toBe(false);
    expect(host.querySelector(".update-chip-label")?.textContent).toBe("v0.9.0 available");
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify).toHaveBeenCalledWith("polakapi v0.9.0 is available");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.check).toHaveBeenCalledTimes(2);
    expect(d.notify).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it("stays hidden when the app is up to date", async () => {
    const d = deps({
      check: vi
        .fn()
        .mockResolvedValue({ ...newer, latestVersion: "0.8.0", updateAvailable: false }),
    });
    mountUpdateIndicator(host, d);
    await vi.advanceTimersByTimeAsync(0);

    expect(host.hidden).toBe(true);
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("opens the release page on click", async () => {
    const d = deps();
    mountUpdateIndicator(host, d);
    await vi.advanceTimersByTimeAsync(0);

    host.querySelector<HTMLButtonElement>(".update-chip")?.click();
    expect(d.openUrl).toHaveBeenCalledWith(newer.releaseUrl);
  });

  it("dismisses the current version and persists it", async () => {
    const d = deps();
    mountUpdateIndicator(host, d);
    await vi.advanceTimersByTimeAsync(0);

    host.querySelector<HTMLElement>(".update-chip-dismiss")?.click();
    expect(d.saveDismissed).toHaveBeenCalledWith("0.9.0");
    expect(host.hidden).toBe(true);
    expect(d.openUrl).not.toHaveBeenCalled();
  });

  it("respects a previously dismissed version but surfaces an even newer one", async () => {
    const check = vi.fn<() => Promise<UpdateCheck>>().mockResolvedValue(newer);
    const d = deps({ check, loadDismissed: vi.fn().mockResolvedValue("0.9.0") });
    mountUpdateIndicator(host, d);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.hidden).toBe(true);
    expect(d.notify).not.toHaveBeenCalled();

    check.mockResolvedValue({ ...newer, latestVersion: "0.10.0" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.hidden).toBe(false);
    expect(host.querySelector(".update-chip-label")?.textContent).toBe("v0.10.0 available");
    expect(d.notify).toHaveBeenCalledWith("polakapi v0.10.0 is available");
  });

  it("swallows check failures and keeps polling", async () => {
    const check = vi.fn<() => Promise<UpdateCheck>>().mockRejectedValue(new Error("offline"));
    const d = deps({ check });
    mountUpdateIndicator(host, d);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.hidden).toBe(true);

    check.mockResolvedValue(newer);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.hidden).toBe(false);
  });

  it("stops polling after dispose", async () => {
    const d = deps();
    const handle = mountUpdateIndicator(host, d);
    await vi.advanceTimersByTimeAsync(0);
    handle.dispose();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(d.check).toHaveBeenCalledTimes(1);
    expect(host.childElementCount).toBe(0);
  });
});
