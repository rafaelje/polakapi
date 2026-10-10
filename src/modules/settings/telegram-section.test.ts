import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeStatus,
  mountTelegramSection,
  parseNames,
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
  addressAs: [],
  botName: "",
  forwardNotifications: false,
  remoteApprovals: false,
  confirmActions: true,
  allowSudo: false,
  voiceNotes: false,
  whisperModel: "",
  voiceLanguage: "auto",
  voiceReplies: "off",
  piperVoice: "",
  voiceSpeed: 100,
};

const onError = vi.fn();
const onMessage = vi.fn();
const setConfig = vi.fn<(patch: TelegramConfigPatch) => Promise<TelegramConfigView>>();
const test = vi.fn(() => Promise.resolve("@polabot"));
const checkVoice = vi.fn(() => Promise.resolve("/usr/bin/whisper-cli with ggml-small.bin"));

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
    checkVoice,
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

  it("saves the bot's name trimmed", async () => {
    await mount({ botName: "Daniela" });
    const name = control<HTMLInputElement>("Bot name");
    expect(name.value).toBe("Daniela");
    name.value = "  Dani  ";
    name.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(setConfig).toHaveBeenCalledWith({ botName: "Dani" }));
  });

  it("saves the names to address the user by", async () => {
    await mount({ addressAs: ["Miguel"] });
    const address = control<HTMLInputElement>("Address me as");
    expect(address.value).toBe("Miguel");
    address.value = " Miguel, jefe,, miguel ";
    address.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ addressAs: ["Miguel", "jefe"] }),
    );
    expect(parseNames("")).toEqual([]);
  });

  it("turns voice notes on and checks whisper", async () => {
    await mount();
    const language = control<HTMLSelectElement>("Voice language");
    expect(language.disabled).toBe(true);
    const voice = control<HTMLInputElement>("Voice notes");
    voice.checked = true;
    voice.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(language.disabled).toBe(false));
    expect(setConfig).toHaveBeenCalledWith({ voiceNotes: true });
    const piper = control<HTMLInputElement>("Piper voice");
    expect(piper.disabled).toBe(true);
    const replies = control<HTMLSelectElement>("Voice answers");
    replies.value = "reply";
    replies.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(piper.disabled).toBe(false));
    expect(setConfig).toHaveBeenCalledWith({ voiceReplies: "reply" });
    const speed = control<HTMLInputElement>("Voice speed");
    expect(speed.disabled).toBe(false);
    speed.value = "90";
    speed.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(setConfig).toHaveBeenCalledWith({ voiceSpeed: 90 }));
    button("Check").click();
    await vi.waitFor(() =>
      expect(onMessage).toHaveBeenCalledWith(
        "Voice notes ready: /usr/bin/whisper-cli with ggml-small.bin.",
      ),
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

  it("only asks before acting when the agent can act", async () => {
    await mount();
    const confirm = control<HTMLInputElement>("Ask before acting");
    expect(confirm.checked).toBe(true);
    expect(confirm.disabled).toBe(true);
    const profile = control<HTMLSelectElement>("Tool profile");
    profile.value = "full";
    profile.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(confirm.disabled).toBe(false));
  });

  it("keeps sudo off until it is switched on in settings", async () => {
    await mount({ profile: "full" });
    const sudo = control<HTMLInputElement>("Allow sudo");
    expect(sudo.checked).toBe(false);
    expect(sudo.disabled).toBe(false);
    sudo.checked = true;
    sudo.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(setConfig).toHaveBeenCalledWith({ allowSudo: true }));
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
