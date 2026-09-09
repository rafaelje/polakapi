import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
}));
vi.mock("../../shared/tauri/invoke", () => ({ invoke: vi.fn() }));
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { invoke } from "../../shared/tauri/invoke";
import { defaults, normalizePreferences } from "./preferences";
import { deliverNotification } from "./notifications";
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
  vi.mocked(invoke).mockResolvedValue(undefined);
});
describe("notification delivery", () => {
  it("leaves notification commands disabled for existing and malformed preferences", () => {
    expect(normalizePreferences({ sound: "none" }).command).toBe("");
    expect(normalizePreferences({ command: 123 }).command).toBe("");
    expect(normalizePreferences({ command: 'say "done"' }).command).toBe('say "done"');
  });
  it("runs the configured command with metadata when sound and desktop delivery are off", async () => {
    await deliverNotification(
      "Agent",
      "Done",
      {
        ...defaults,
        desktop: false,
        sound: "none",
        command: 'say "$POLAKAPI_NOTIFICATION_BODY"',
      },
      "finished",
    );
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "notification_run_command",
      {
        command: 'say "$POLAKAPI_NOTIFICATION_BODY"',
        title: "Agent",
        body: "Done",
        event: "finished",
      },
      { toastOnError: true, errorMessage: "Notification command failed. Check App Settings." },
    );
    expect(isPermissionGranted).not.toHaveBeenCalled();
  });
  it("ignores a whitespace-only command", async () => {
    await deliverNotification("Agent", "Done", {
      ...defaults,
      desktop: false,
      sound: "none",
      command: "  ",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
  it("delivers sound and desktop notifications even when the command fails", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      command === "notification_run_command"
        ? Promise.reject(new Error("command failed"))
        : Promise.resolve(undefined),
    );
    await expect(
      deliverNotification("Agent", "Done", {
        ...defaults,
        sound: "/tmp/ping.wav",
        command: "exit 7",
      }),
    ).rejects.toThrow("command failed");
    expect(invoke).toHaveBeenCalledWith(
      "notification_play_sound",
      { path: "/tmp/ping.wav" },
      { toastOnError: false },
    );
    expect(invoke).toHaveBeenCalledWith(
      "notification_send",
      { title: "Agent", body: "Done", defaultSound: false },
      { toastOnError: false },
    );
  });
  it("runs the command even when desktop permission fails", async () => {
    vi.mocked(isPermissionGranted).mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      deliverNotification("Agent", "Done", { ...defaults, command: "echo done" }, "waiting"),
    ).rejects.toThrow("unavailable");
    expect(invoke).toHaveBeenCalledWith(
      "notification_run_command",
      { command: "echo done", title: "Agent", body: "Done", event: "waiting" },
      expect.anything(),
    );
  });
  it("uses the default sound only when selected", async () => {
    await deliverNotification("Agent", "Done", defaults);
    expect(invoke).toHaveBeenCalledWith(
      "notification_send",
      { title: "Agent", body: "Done", defaultSound: true },
      { toastOnError: false },
    );
  });
  it("plays a custom file separately from a silent banner", async () => {
    await deliverNotification("Agent", "Done", {
      ...defaults,
      sound: "/tmp/my sound.aiff",
    });
    expect(invoke).toHaveBeenCalledWith(
      "notification_send",
      { title: "Agent", body: "Done", defaultSound: false },
      { toastOnError: false },
    );
    expect(invoke).toHaveBeenCalledWith(
      "notification_play_sound",
      { path: "/tmp/my sound.aiff" },
      { toastOnError: false },
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("skips desktop permission and delivery when disabled", async () => {
    await deliverNotification("Agent", "Done", { ...defaults, desktop: false, sound: "none" });
    expect(isPermissionGranted).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("does not cache denied permissions across settings changes", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(requestPermission).mockResolvedValue("denied");
    await deliverNotification("Agent", "Done", defaults);
    expect(invoke).not.toHaveBeenCalled();
    await deliverNotification("Agent", "Done", defaults);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("still plays the custom sound if querying desktop permission fails", async () => {
    vi.mocked(isPermissionGranted).mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      deliverNotification("Agent", "Done", { ...defaults, sound: "/tmp/ping.wav" }),
    ).rejects.toThrow("unavailable");
    expect(invoke).toHaveBeenCalledWith(
      "notification_play_sound",
      { path: "/tmp/ping.wav" },
      { toastOnError: false },
    );
  });
});
