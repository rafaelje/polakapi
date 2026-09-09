import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as InvokeModule from "../../shared/tauri/invoke";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
}));
vi.mock("../../shared/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof InvokeModule>()),
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("./preferences", () => ({
  loadPreferences: vi.fn(),
  savePreferences: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./notifications", () => ({
  deliverNotification: vi.fn().mockResolvedValue(undefined),
  runNotificationCommand: vi.fn().mockResolvedValue(undefined),
}));

import { loadPreferences, savePreferences } from "./preferences";
import { deliverNotification, runNotificationCommand } from "./notifications";
import { InvokeError } from "../../shared/tauri/invoke";

const input = () =>
  document.querySelector<HTMLInputElement>('[aria-label="Notification Command"]')!;
const testButton = () =>
  document.querySelector<HTMLButtonElement>('[aria-label="Test notification command"]')!;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.mocked(loadPreferences).mockResolvedValue({
    permission: true,
    waiting: true,
    finished: "idle",
    desktop: true,
    sound: "default",
    command: 'say "done"',
  });
  document.body.innerHTML = '<div id="settings"></div>';
  await import("./settings");
  await vi.waitFor(() => expect(input()).not.toBeNull());
});

describe("notification command settings", () => {
  it("loads the saved command and saves edits only after committing the field", async () => {
    expect(input().value).toBe('say "done"');
    input().value = "echo changed";
    input().dispatchEvent(new Event("input"));
    expect(savePreferences).not.toHaveBeenCalled();
    input().dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(savePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ command: "echo changed" }),
      ),
    );
  });
  it("tests the entered command and displays success", async () => {
    testButton().click();
    await vi.waitFor(() =>
      expect(runNotificationCommand).toHaveBeenCalledWith(
        'say "done"',
        "polakapi",
        "Your agent notifications are ready.",
        "test",
        false,
      ),
    );
    await vi.waitFor(() =>
      expect(document.querySelector(".settings-status")?.textContent).toContain(
        "completed successfully",
      ),
    );
    expect(deliverNotification).not.toHaveBeenCalled();
  });
  it("shows failures and re-enables the controls", async () => {
    vi.mocked(runNotificationCommand).mockRejectedValueOnce(
      new InvokeError("notification_run_command", "Notification command exited with code 7"),
    );
    testButton().click();
    await vi.waitFor(() =>
      expect(document.querySelector(".settings-status")?.textContent).toContain(
        "exited with code 7",
      ),
    );
    expect(input().disabled).toBe(false);
    expect(testButton().disabled).toBe(false);
  });
  it("disables testing an empty command", () => {
    input().value = " ";
    input().dispatchEvent(new Event("input"));
    expect(testButton().disabled).toBe(true);
  });
  it("does not run the notification command when previewing the default sound", async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Preview notification sound"]')!.click();
    await vi.waitFor(() =>
      expect(deliverNotification).toHaveBeenCalledWith(
        "polakapi",
        "Notification sound preview",
        expect.objectContaining({ command: "" }),
      ),
    );
  });
});
