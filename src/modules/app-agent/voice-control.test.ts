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

import { dictationPrompt, mountVoiceControl, type VoiceAgent } from "./voice-control";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    voiceControl: true,
    voiceControlTarget: "headless",
    voiceControlReplies: "off",
    ...overrides,
  };
}

function mount(agent: VoiceAgent = { cli: "claude", ptyId: "pty-1" }) {
  const bar = document.createElement("div");
  const anchor = document.createElement("button");
  bar.append(anchor);
  const log = document.createElement("div");
  document.body.append(bar, log);
  const handle = mountVoiceControl({ after: anchor, log, agent: () => agent });
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

describe("voice control", () => {
  beforeEach(() => {
    invoke.mockReset();
    ptyWrite.mockClear();
  });
  afterEach(() => {
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
    await flush();
    mic.click();
    await flush();
    mic.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("voice_speak", { text: "All quiet." });
  });

  it("types the dictation into the running agent and speaks its answer", async () => {
    answer(settings({ voiceControlTarget: "agent", voiceControlReplies: "reply" }), {
      voice_record_stop: "open polakapi",
      voice_agent_reply: "Opened.",
    });
    const { mic } = mount({ cli: "codex", ptyId: "pty-9" });
    await flush();
    mic.click();
    await flush();
    mic.click();
    await flush();
    const prompt = dictationPrompt("open polakapi");
    expect(invoke).toHaveBeenCalledWith("voice_agent_mark", { cli: "codex" });
    expect(ptyWrite).toHaveBeenCalledWith("pty-9", `\x1b[200~${prompt}\x1b[201~\r`);
    expect(invoke).toHaveBeenCalledWith("voice_agent_reply", { text: prompt });
    expect(invoke).toHaveBeenCalledWith("voice_speak", { text: "Opened." });
  });

  it("asks to start the agent before typing into it", async () => {
    answer(settings({ voiceControlTarget: "agent" }), { voice_record_stop: "hola" });
    const { mic, status } = mount({ cli: "claude", ptyId: null });
    await flush();
    mic.click();
    await flush();
    mic.click();
    await flush();
    expect(ptyWrite).not.toHaveBeenCalled();
    expect(status.textContent).toMatch(/Start the agent first/);
    expect(status.classList.contains("is-error")).toBe(true);
  });

  it("cancels quietly", async () => {
    let release: (value: unknown) => void = () => {};
    invoke.mockImplementation((command) => {
      if (command === "telegram_config_get") return Promise.resolve(settings());
      if (command === "voice_record_stop") return Promise.resolve("hola");
      if (command === "voice_ask")
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
    await flush();
    mic.click();
    await flush();
    mic.click();
    await flush();
    expect(mic.textContent).toBe("Stop");
    mic.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("voice_cancel", {});
    expect(status.textContent).toBe("");
    expect(mic.textContent).toContain("Talk");
  });
});
