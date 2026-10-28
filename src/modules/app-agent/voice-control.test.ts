import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, ptyWrite, listen } = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  ptyWrite: vi.fn<(id: string, data: string) => Promise<void>>(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../../shared/tauri/invoke", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => invoke(command, args),
}));
vi.mock("../terminal/pty-client", () => ({
  ptyWrite: (id: string, data: string) => ptyWrite(id, data),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import {
  dictationPrompt,
  isVoiceShortcut,
  mountVoiceControl,
  type VoiceAgent,
} from "./voice-control";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const handles: Array<{ dispose(): void }> = [];

function settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    voiceControl: true,
    voiceControlTarget: "headless",
    voiceControlReplies: "off",
    ...overrides,
  };
}

function mount(
  agent: VoiceAgent = { cli: "claude", ptyId: "pty-1" },
  startAgent: () => Promise<VoiceAgent> = () => Promise.resolve(agent),
  extra: { available?: () => boolean; reveal?: () => void } = {},
) {
  const bar = document.createElement("div");
  const anchor = document.createElement("button");
  bar.append(anchor);
  const log = document.createElement("div");
  document.body.append(bar, log);
  const handle = mountVoiceControl({
    after: anchor,
    log,
    agent: () => agent,
    startAgent,
    available: extra.available ?? (() => true),
    reveal: extra.reveal,
  });
  handles.push(handle);
  const mic = bar.querySelector<HTMLButtonElement>(".agent-panel-mic")!;
  const status = bar.querySelector<HTMLElement>(".agent-voice-status")!;
  return { handle, mic, status, log };
}

function answer(config: Record<string, unknown>, replies: Record<string, unknown>): void {
  invoke.mockImplementation((command) => {
    if (command === "telegram_config_get") return Promise.resolve(config);
    if (command in replies) return Promise.resolve(replies[command]);
    return Promise.resolve(undefined);
  });
}

async function dictate(mic: HTMLButtonElement): Promise<void> {
  await flush();
  mic.click();
  await flush();
  mic.click();
  await flush();
}

describe("voice control", () => {
  beforeEach(() => {
    invoke.mockReset();
    ptyWrite.mockClear();
  });
  afterEach(() => {
    for (const handle of handles.splice(0)) handle.dispose();
    document.body.replaceChildren();
  });

  it("hides the microphone while voice control is off", async () => {
    answer(settings({ voiceControl: false }), {});
    const { mic } = mount();
    await flush();
    expect(mic.hidden).toBe(true);
  });

  it("asks a headless turn and shows the answer", async () => {
    answer(settings(), { voice_record_stop: " list my projects ", voice_ask: "Two projects." });
    const { mic, log } = mount();
    await flush();
    expect(mic.hidden).toBe(false);
    mic.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("voice_record_start", {});
    expect(mic.textContent).toContain("Send");
    mic.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("voice_ask", { text: "list my projects", cli: "claude" });
    expect(ptyWrite).not.toHaveBeenCalled();
    expect(log.hidden).toBe(false);
    expect(log.textContent).toContain("🎤 list my projects");
    expect(log.textContent).toContain("Two projects.");
    expect(invoke).not.toHaveBeenCalledWith("voice_speak", expect.anything());
    expect(mic.textContent).toContain("Talk");
  });

  it("reads the headless answer aloud when asked to", async () => {
    answer(settings({ voiceControlReplies: "reply" }), {
      voice_record_stop: "status",
      voice_ask: "All quiet.",
    });
    const { mic } = mount();
    await dictate(mic);
    expect(invoke).toHaveBeenCalledWith("voice_speak", { text: "All quiet." });
  });

  it("starts a new headless conversation on request", async () => {
    answer(settings(), { voice_record_stop: "hola", voice_ask: "Hola." });
    const { mic, log } = mount();
    await dictate(mic);
    const forget = Array.from(log.querySelectorAll("button")).find(
      (button) => button.textContent === "New conversation",
    )!;
    expect(forget.hidden).toBe(false);
    forget.click();
    expect(invoke).toHaveBeenCalledWith("voice_forget", {});
    expect(log.hidden).toBe(true);
  });

  it("types the dictation into the running agent and shows what was heard", async () => {
    answer(settings({ voiceControlTarget: "agent" }), { voice_record_stop: " list my projects " });
    const { mic, log } = mount();
    await flush();
    expect(mic.hidden).toBe(false);
    mic.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("voice_record_start", {});
    expect(mic.textContent).toContain("Send");
    mic.click();
    await flush();
    const prompt = dictationPrompt("list my projects");
    expect(ptyWrite).toHaveBeenCalledWith("pty-1", `\x1b[200~${prompt}\x1b[201~\r`);
    expect(log.hidden).toBe(false);
    expect(log.textContent).toContain("🎤 list my projects");
    expect(invoke).not.toHaveBeenCalledWith("voice_agent_mark", expect.anything());
    expect(mic.textContent).toContain("Talk");
  });

  it("speaks the agent's answer when asked to", async () => {
    answer(settings({ voiceControlTarget: "agent", voiceControlReplies: "reply" }), {
      voice_record_stop: "open polakapi",
      voice_agent_reply: "Opened.",
    });
    const { mic } = mount({ cli: "codex", ptyId: "pty-9" });
    await dictate(mic);
    const prompt = dictationPrompt("open polakapi");
    expect(invoke).toHaveBeenCalledWith("voice_agent_mark", { cli: "codex" });
    expect(ptyWrite).toHaveBeenCalledWith("pty-9", `\x1b[200~${prompt}\x1b[201~\r`);
    expect(invoke).toHaveBeenCalledWith("voice_agent_reply", { text: prompt });
    expect(invoke).toHaveBeenCalledWith("voice_speak", { text: "Opened." });
  });

  it("starts the selected agent before typing into it", async () => {
    answer(settings({ voiceControlTarget: "agent" }), { voice_record_stop: "hola" });
    const startAgent = vi.fn(() => Promise.resolve({ cli: "codex", ptyId: "pty-new" }));
    const { mic } = mount({ cli: "codex", ptyId: null }, startAgent);
    await dictate(mic);
    expect(startAgent).toHaveBeenCalledOnce();
    expect(ptyWrite).toHaveBeenCalledWith("pty-new", expect.stringContaining("hola"));
  });

  it("says so when the agent could not start", async () => {
    answer(settings({ voiceControlTarget: "agent" }), { voice_record_stop: "hola" });
    const { mic, status } = mount({ cli: "claude", ptyId: null });
    await dictate(mic);
    expect(ptyWrite).not.toHaveBeenCalled();
    expect(status.textContent).toBe("Could not start claude.");
    expect(status.classList.contains("is-error")).toBe(true);
  });

  it("listens on Ctrl+Shift+K and shows the agent tab", async () => {
    answer(settings(), {});
    const reveal = vi.fn();
    const { mic } = mount(undefined, undefined, { reveal });
    await flush();
    const event = new KeyboardEvent("keydown", {
      key: "K",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(reveal).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("voice_record_start", {});
    expect(mic.textContent).toContain("Send");
  });

  it("leaves the shortcut alone while the agent lives in another window", async () => {
    answer(settings(), {});
    mount(undefined, undefined, { available: () => false });
    await flush();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, shiftKey: true }));
    await flush();
    expect(invoke).not.toHaveBeenCalledWith("voice_record_start", expect.anything());
  });

  it("matches the shortcut per platform", () => {
    const keys = { key: "K", code: "KeyK", shiftKey: true, altKey: false };
    expect(isVoiceShortcut({ ...keys, ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(isVoiceShortcut({ ...keys, ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(isVoiceShortcut({ ...keys, ctrlKey: true, metaKey: false }, true)).toBe(false);
    expect(
      isVoiceShortcut({ ...keys, shiftKey: false, ctrlKey: true, metaKey: false }, false),
    ).toBe(false);
  });

  it.each([
    ["headless", "voice_ask"],
    ["agent", "voice_agent_reply"],
  ])("cancels a %s dictation quietly", async (target, pending) => {
    let release: (value: unknown) => void = () => {};
    invoke.mockImplementation((command) => {
      if (command === "telegram_config_get")
        return Promise.resolve(
          settings({ voiceControlTarget: target, voiceControlReplies: "reply" }),
        );
      if (command === "voice_record_stop") return Promise.resolve("hola");
      if (command === pending)
        return new Promise((_resolve, reject) => {
          release = () => reject(new Error("cancelled"));
        });
      if (command === "voice_cancel") {
        release(undefined);
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });
    const { mic, status } = mount();
    await dictate(mic);
    expect(mic.textContent).toBe("Stop");
    mic.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("voice_cancel", {});
    expect(status.textContent).toBe("");
    expect(mic.textContent).toContain("Talk");
  });
});
