import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "../../shared/tauri/invoke";
import { stringifyError } from "../../shared/errors";
import { bracketedPaste } from "../agents-library/compose";
import { ptyWrite } from "../terminal/pty-client";

// The agent tab's microphone: records a dictation, transcribes it on this
// computer and either asks a headless operator turn or types it into the
// running agent, depending on Settings → Voice control. Answers can be read
// aloud. The Rust side (voice_control.rs) owns every process.

export const VOICE_CONFIG_EVENT = "telegram-config";
const CANCELLED = "cancelled";

export interface VoiceSettings {
  voiceControl: boolean;
  voiceControlTarget: string;
  voiceControlReplies: string;
}

export interface VoiceAgent {
  cli: string;
  /** The running agent's PTY, or null when it is stopped or exited. */
  ptyId: string | null;
}

export interface VoiceControlOptions {
  /** The bar control the microphone button follows. */
  after: HTMLElement;
  /** Placed between the bar and the terminal. */
  log: HTMLElement;
  agent: () => VoiceAgent;
}

export interface VoiceControlHandle {
  dispose(): void;
}

type Phase = "idle" | "recording" | "busy";

export function dictationPrompt(text: string): string {
  return `[voice] ${text.trim()}`;
}

export function mountVoiceControl(opts: VoiceControlOptions): VoiceControlHandle {
  const micBtn = document.createElement("button");
  micBtn.type = "button";
  micBtn.className = "agent-panel-btn agent-panel-mic";
  micBtn.dataset.noDrag = "";
  micBtn.hidden = true;
  const voiceStatus = document.createElement("span");
  voiceStatus.className = "agent-voice-status";
  opts.after.after(micBtn, voiceStatus);

  opts.log.className = "agent-voice-log";
  opts.log.hidden = true;
  const heard = document.createElement("p");
  heard.className = "agent-voice-heard";
  const answer = document.createElement("div");
  answer.className = "agent-voice-answer";
  const actions = document.createElement("div");
  actions.className = "agent-voice-actions";
  const forgetBtn = document.createElement("button");
  forgetBtn.type = "button";
  forgetBtn.className = "agent-panel-btn";
  forgetBtn.textContent = "New conversation";
  forgetBtn.title = "The next dictation starts a fresh headless conversation";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "agent-panel-btn";
  closeBtn.textContent = "Close";
  actions.append(forgetBtn, closeBtn);
  opts.log.append(heard, answer, actions);

  let settings: VoiceSettings | null = null;
  let phase: Phase = "idle";
  let disposed = false;
  let unlisten: UnlistenFn | null = null;

  const setStatus = (text: string, kind: "" | "error" = ""): void => {
    voiceStatus.textContent = text;
    voiceStatus.classList.toggle("is-error", kind === "error");
  };

  const render = (): void => {
    micBtn.hidden = !settings?.voiceControl;
    micBtn.classList.toggle("is-recording", phase === "recording");
    if (phase === "recording") {
      micBtn.textContent = "■ Send";
      micBtn.title = "Stop recording and send what you said";
    } else if (phase === "busy") {
      micBtn.textContent = "Stop";
      micBtn.title = "Stop transcribing, thinking or speaking";
    } else {
      micBtn.textContent = "🎤 Talk";
      micBtn.title = "Dictate to the agent";
    }
  };

  const apply = (next: VoiceSettings): void => {
    settings = next;
    if (!next.voiceControl && phase !== "idle") void cancel();
    render();
  };

  const load = async (): Promise<VoiceSettings | null> => {
    try {
      const next = await invoke<VoiceSettings>("telegram_config_get", {}, { toastOnError: false });
      if (!disposed) apply(next);
      return next;
    } catch {
      return null;
    }
  };

  const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> =>
    invoke<T>(command, args, { toastOnError: false });

  const fail = (error: unknown): void => {
    const message = stringifyError(error);
    if (message.includes(CANCELLED)) {
      setStatus("");
      return;
    }
    setStatus(message.replace(/^invoke "[^"]+" failed: /, ""), "error");
  };

  const showExchange = (said: string, reply: string | null, headless: boolean): void => {
    heard.textContent = `🎤 ${said}`;
    answer.textContent = reply ?? "";
    answer.hidden = reply === null;
    forgetBtn.hidden = !headless;
    opts.log.hidden = false;
  };

  const speak = async (text: string): Promise<void> => {
    setStatus("Speaking…");
    await call("voice_speak", { text });
  };

  const toAgent = async (text: string, current: VoiceSettings): Promise<void> => {
    const agent = opts.agent();
    if (!agent.ptyId)
      throw new Error(
        "Start the agent first, or send dictation to a headless turn in Settings → Voice control.",
      );
    const prompt = dictationPrompt(text);
    const wantsReply = current.voiceControlReplies === "reply";
    let watching = false;
    if (wantsReply) {
      watching = await call("voice_agent_mark", { cli: agent.cli })
        .then(() => true)
        .catch(() => false);
    }
    await ptyWrite(agent.ptyId, bracketedPaste(prompt) + "\r");
    showExchange(text, null, false);
    if (!watching) {
      setStatus(wantsReply ? `Sent. ${agent.cli} answers cannot be read aloud.` : "Sent.");
      return;
    }
    setStatus("Waiting for the answer…");
    const reply = await call<string | null>("voice_agent_reply", { text: prompt });
    if (reply) await speak(reply);
    setStatus("");
  };

  const toHeadless = async (text: string, current: VoiceSettings): Promise<void> => {
    showExchange(text, null, true);
    setStatus("Thinking…");
    const reply = await call<string>("voice_ask", { text, cli: opts.agent().cli || null });
    showExchange(text, reply, true);
    if (current.voiceControlReplies === "reply") await speak(reply);
    setStatus("");
  };

  const startRecording = async (): Promise<void> => {
    const current = await load();
    if (!current?.voiceControl || disposed) return;
    phase = "busy";
    render();
    setStatus("Opening the microphone…");
    try {
      await call("voice_record_start");
      if (phase !== "busy" || disposed) return;
      phase = "recording";
      setStatus("Listening… press Send when you finish.");
    } catch (error) {
      if (phase === "busy") phase = "idle";
      fail(error);
    } finally {
      render();
    }
  };

  const finishRecording = async (): Promise<void> => {
    phase = "busy";
    render();
    setStatus("Transcribing…");
    try {
      const text = (await call<string>("voice_record_stop")).trim();
      const current = settings;
      if (!text || !current) {
        setStatus("Nothing was heard.");
        return;
      }
      if (current.voiceControlTarget === "agent") await toAgent(text, current);
      else await toHeadless(text, current);
    } catch (error) {
      fail(error);
    } finally {
      if (phase === "busy") phase = "idle";
      render();
    }
  };

  const cancel = async (): Promise<void> => {
    phase = "idle";
    render();
    setStatus("");
    await call("voice_cancel").catch(() => undefined);
  };

  const onMic = (): void => {
    if (phase === "idle") void startRecording();
    else if (phase === "recording") void finishRecording();
    else void cancel();
  };
  const onForget = (): void => {
    void call("voice_forget").catch(() => undefined);
    opts.log.hidden = true;
  };
  const onClose = (): void => {
    opts.log.hidden = true;
  };
  micBtn.addEventListener("click", onMic);
  forgetBtn.addEventListener("click", onForget);
  closeBtn.addEventListener("click", onClose);

  void load();
  listen<VoiceSettings>(VOICE_CONFIG_EVENT, (event) => {
    if (!disposed) apply(event.payload);
  })
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch((error: unknown) => console.error("voice control: could not watch settings", error));
  render();

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      micBtn.removeEventListener("click", onMic);
      forgetBtn.removeEventListener("click", onForget);
      closeBtn.removeEventListener("click", onClose);
      unlisten?.();
      if (phase !== "idle") void call("voice_cancel").catch(() => undefined);
    },
  };
}
