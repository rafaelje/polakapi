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
// The Context Mode section reads its own store; without this the real plugin
// would run in jsdom and take the whole settings window down.
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn().mockResolvedValue({
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));

import { listen } from "@tauri-apps/api/event";
import { loadPreferences, savePreferences } from "./preferences";
import { deliverNotification, runNotificationCommand } from "./notifications";
import { InvokeError, invoke } from "../../shared/tauri/invoke";

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
    soundEnabled: true,
    sound: "default",
    command: 'say "done"',
  });
  let communicationSettings = { enabled: false, scope: "window" };
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "a2a_settings") return Promise.resolve({ ...communicationSettings });
    if (command === "a2a_update_settings") {
      communicationSettings = {
        ...communicationSettings,
        ...(args as Partial<typeof communicationSettings>),
      };
      return Promise.resolve({ ...communicationSettings });
    }
    if (command === "notification_sounds") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  document.body.innerHTML = '<div id="settings"></div>';
  await import("./settings");
  await vi.waitFor(() => expect(input()).not.toBeNull());
});

describe("agent communication settings", () => {
  it("loads disabled by default and persists the enable switch", async () => {
    const enabled = document.querySelector<HTMLInputElement>('[aria-label="Agent communication"]');
    expect(enabled?.checked).toBe(false);
    enabled!.click();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("a2a_update_settings", { enabled: true }),
    );
  });

  it("reflects toolbar changes and turns the same switch off without granting a reviewer", async () => {
    const enabled = document.querySelector<HTMLInputElement>('[aria-label="Agent communication"]')!;
    const handler = vi.mocked(listen).mock.calls.find(([name]) => name === "a2a:settings")![1];
    handler({ event: "a2a:settings", id: 1, payload: { enabled: true, scope: "all" } });
    expect(enabled.checked).toBe(true);
    expect(enabled.closest(".settings-row")?.textContent).toMatch(/revoke/i);
    enabled.click();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("a2a_update_settings", { enabled: false }),
    );
    expect(invoke).not.toHaveBeenCalledWith("a2a_review_share", expect.anything());
  });

  it("persists the selected communication scope", async () => {
    const scope = document.querySelector<HTMLSelectElement>(
      '[aria-label="Agent communication scope"]',
    );
    expect(scope?.value).toBe("window");
    scope!.value = "all";
    scope!.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("a2a_update_settings", { scope: "all" }),
    );
  });
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
