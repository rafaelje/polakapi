import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeStatus,
  mountTelegramSection,
  parseUserIds,
  type TelegramConfigPatch,
  type TelegramConfigView,
} from "./telegram-section";

const control = <T extends HTMLElement>(label: string): T =>
  document.querySelector<T>(`[aria-label="${label}"]`)!;
const button = (text: string): HTMLButtonElement =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === text)!;

const baseConfig: TelegramConfigView = {
  enabled: false,
  hasToken: false,
  tokenHint: "",
  allowedUserIds: [],
  cli: "claude",
  profile: "readonly",
  turnTimeoutSecs: 600,
  replyStyle: "",
  forwardNotifications: false,
  remoteApprovals: false,
};

const onError = vi.fn();
const onMessage = vi.fn();
const setConfig = vi.fn<(patch: TelegramConfigPatch) => Promise<TelegramConfigView>>();
const test = vi.fn(() => Promise.resolve("@polabot"));

async function mount(patch: Partial<TelegramConfigView> = {}): Promise<void> {
  document.body.innerHTML = '<div class="settings-group"></div>';
  let config = { ...baseConfig, ...patch };
  setConfig.mockImplementation((next) => {
    const { token, ...rest } = next;
    config = {
      ...config,
      ...rest,
      ...(token === undefined
        ? {}
        : { hasToken: token !== "", tokenHint: token ? `••••${token.slice(-4)}` : "" }),
    };
    return Promise.resolve(config);
  });
  const api = {
    getConfig: () => Promise.resolve(config),
    setConfig,
    getStatus: () =>
      Promise.resolve({
        state: "stopped" as const,
        detail: "disabled",
        botUsername: null,
        ignored: 0,
      }),
    test,
    watchStatus: () => Promise.resolve(() => {}),
  };
  await mountTelegramSection({
    group: document.querySelector<HTMLElement>(".settings-group")!,
    api,
    onError,
    onMessage,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("telegram section", () => {
  it("never shows a saved token, only its hint", async () => {
    await mount({ hasToken: true, tokenHint: "••••wxyz" });
    const token = control<HTMLInputElement>("Bot token");
    expect(token.value).toBe("");
    expect(token.placeholder).toBe("Saved (••••wxyz)");
    expect(button("Save").disabled).toBe(true);
    expect(button("Remove").disabled).toBe(false);
  });

  it("saves a pasted token and clears the field", async () => {
    await mount();
    const token = control<HTMLInputElement>("Bot token");
    token.value = "123:abcdefghijklmnopqrstuvwxyz";
    token.dispatchEvent(new Event("input"));
    button("Save").click();
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith("Bot token saved."));
    expect(setConfig).toHaveBeenCalledWith({ token: "123:abcdefghijklmnopqrstuvwxyz" });
    expect(token.value).toBe("");
  });

  it("tests the typed token before falling back to the saved one", async () => {
    await mount({ hasToken: true, tokenHint: "••••wxyz" });
    button("Test").click();
    await vi.waitFor(() =>
      expect(onMessage).toHaveBeenCalledWith("Telegram accepted the token for @polabot."),
    );
    expect(test).toHaveBeenCalledWith(undefined);
  });

  it("validates allowed user ids before saving", async () => {
    await mount();
    const users = control<HTMLInputElement>("Allowed user ids");
    users.value = "12, abc";
    users.dispatchEvent(new Event("change"));
    expect(onError).toHaveBeenCalled();
    expect(setConfig).not.toHaveBeenCalled();
    users.value = "12, 34 12";
    users.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(setConfig).toHaveBeenCalledWith({ allowedUserIds: [12, 34] }));
  });

  it("saves the reply style trimmed", async () => {
    await mount({ replyStyle: "brief" });
    const style = control<HTMLTextAreaElement>("Reply style");
    expect(style.value).toBe("brief");
    style.value = "  en español, informal  ";
    style.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ replyStyle: "en español, informal" }),
    );
  });

  it("only offers permission buttons while notifications are forwarded", async () => {
    await mount();
    const approvals = control<HTMLInputElement>("Permission buttons");
    expect(approvals.disabled).toBe(true);
    const forward = control<HTMLInputElement>("Agent notifications");
    forward.checked = true;
    forward.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(approvals.disabled).toBe(false));
    expect(setConfig).toHaveBeenCalledWith({ forwardNotifications: true });
  });

  it("surfaces a rejected save", async () => {
    await mount();
    vi.mocked(setConfig).mockRejectedValueOnce(new Error("bad token"));
    const enabled = control<HTMLInputElement>("Telegram bot");
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("bad token"));
    expect(enabled.checked).toBe(false);
  });
});

describe("telegram helpers", () => {
  it("parses ids", () => {
    expect(parseUserIds("")).toEqual([]);
    expect(parseUserIds("1,2\n3 3")).toEqual([1, 2, 3]);
    expect(parseUserIds("-4")).toBeNull();
    expect(parseUserIds("0")).toBeNull();
  });

  it("describes the bot state", () => {
    expect(describeStatus({ state: "running", detail: "", botUsername: "pola", ignored: 2 })).toBe(
      "@pola is listening · 2 ignored from unknown senders",
    );
    expect(
      describeStatus({ state: "stopped", detail: "disabled", botUsername: null, ignored: 0 }),
    ).toBe("Off. Turn the switch on to start listening.");
    expect(
      describeStatus({ state: "stopped", detail: "no bot token", botUsername: null, ignored: 0 }),
    ).toBe("Stopped: no bot token");
  });
});
