import { settingsRow, settingsSelect, settingsToggle } from "./controls";
import type { TelegramApi, TelegramConfigView } from "./telegram-section";

// The "Voice control" settings section: dictating to the operator agent from
// the agent tab. It lives in the Telegram config, so the whisper model,
// language, Piper voice and speed set there apply here too.

export interface VoiceControlSectionOptions {
  group: HTMLElement;
  api: TelegramApi;
  /** Resolves to what dictation would use. */
  check(): Promise<string>;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}

const TARGET_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["headless", "A headless turn — answer shown above the agent"],
  ["agent", "The running agent — typed into its terminal"],
];

const REPLY_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["off", "Off"],
  ["reply", "Read answers aloud"],
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function mountVoiceControlSection(
  opts: VoiceControlSectionOptions,
): Promise<() => void> {
  const { group, api, onError, onMessage } = opts;
  let config: TelegramConfigView = await api.getConfig();

  async function save(patch: Parameters<TelegramApi["setConfig"]>[0]): Promise<void> {
    try {
      config = await api.setConfig(patch);
    } catch (error) {
      onError(errorText(error));
    }
    render();
  }

  const enabled = settingsToggle("Voice control", config.voiceControl, (checked) => {
    void save({ voiceControl: checked });
  });
  const check = document.createElement("button");
  check.type = "button";
  check.textContent = "Check";
  check.addEventListener("click", () => {
    check.disabled = true;
    opts
      .check()
      .then((found) => onMessage(`Voice control ready: ${found}.`))
      .catch((error: unknown) => onError(`Voice control unavailable: ${errorText(error)}`))
      .finally(() => {
        check.disabled = false;
      });
  });
  settingsRow(
    group,
    "Voice control",
    "Adds a Talk button to the agent tab, also on Ctrl+Shift+K (⌘⇧K on macOS) while polakapi has focus. What you say is recorded with ffmpeg and transcribed on this computer with whisper.cpp; the audio never leaves this machine.",
  ).append(check, enabled);

  const target = settingsSelect(
    "Send dictation to",
    TARGET_OPTIONS,
    config.voiceControlTarget,
    (value) => {
      void save({ voiceControlTarget: value });
    },
  );
  settingsRow(
    group,
    "Send dictation to",
    "A headless turn runs the agent CLI without a terminal, with polakapi's tools, and keeps the conversation until you start a new one. The selected agent gets the text as if you typed it, and is started first when it is not running.",
  ).append(target);

  const replies = settingsSelect(
    "Spoken answers",
    REPLY_OPTIONS,
    config.voiceControlReplies,
    (value) => {
      void save({ voiceControlReplies: value });
    },
  );
  settingsRow(
    group,
    "Spoken answers",
    "Read the answer to each dictation aloud with Piper, using the voice and speed from the Telegram section. Code and terminal output are not read. Running agents: Claude Code and Codex only.",
  ).append(replies);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "telegram-model";
  input.spellcheck = false;
  input.placeholder = "System default";
  input.setAttribute("aria-label", "Microphone");
  input.addEventListener("change", () => {
    void save({ voiceInput: input.value.trim() });
  });
  settingsRow(
    group,
    "Microphone",
    "The ffmpeg capture device: a PulseAudio source on Linux (pactl list short sources), an avfoundation index like :1 on macOS, a DirectShow name on Windows. Empty uses the default microphone.",
  ).append(input);

  function render(): void {
    enabled.checked = config.voiceControl;
    target.value = config.voiceControlTarget;
    target.disabled = !config.voiceControl;
    replies.value = config.voiceControlReplies;
    replies.disabled = !config.voiceControl;
    input.disabled = !config.voiceControl;
    if (document.activeElement !== input) input.value = config.voiceInput;
  }

  render();
  return (
    api.watchConfig?.((next) => {
      config = next;
      render();
    }) ?? Promise.resolve(() => {})
  );
}
