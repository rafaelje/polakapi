import { settingsNumber, settingsRow, settingsSelect, settingsToggle } from "./controls";

// The "Telegram" settings section: the bot that lets allowed Telegram users
// talk to the operator agent. The Rust side owns the config file and never
// sends the token back; this form only sees a hint and can replace it.
// See docs/telegram-bot-plan.md.

export interface TelegramConfigView {
  enabled: boolean;
  hasToken: boolean;
  tokenHint: string;
  allowedUserIds: number[];
  cli: string;
  profile: string;
  turnTimeoutSecs: number;
  replyStyle: string;
  addressAs: string[];
  forwardNotifications: boolean;
  remoteApprovals: boolean;
  confirmActions: boolean;
  allowSudo: boolean;
  voiceNotes: boolean;
  whisperModel: string;
  voiceLanguage: string;
}

export type TelegramConfigPatch = Partial<
  Pick<
    TelegramConfigView,
    | "enabled"
    | "allowedUserIds"
    | "cli"
    | "profile"
    | "turnTimeoutSecs"
    | "replyStyle"
    | "addressAs"
    | "forwardNotifications"
    | "remoteApprovals"
    | "confirmActions"
    | "allowSudo"
    | "voiceNotes"
    | "whisperModel"
    | "voiceLanguage"
  >
> & { token?: string };

export interface TelegramStatusView {
  state: "stopped" | "starting" | "running" | "error";
  detail: string;
  botUsername: string | null;
  ignored: number;
}

export interface TelegramApi {
  getConfig(): Promise<TelegramConfigView>;
  setConfig(patch: TelegramConfigPatch): Promise<TelegramConfigView>;
  getStatus(): Promise<TelegramStatusView>;
  /** Resolves to the bot's @username. */
  test(token?: string): Promise<string>;
  /** Resolves to the whisper-cli and model voice notes would use. */
  checkVoice(): Promise<string>;
  watchStatus(onChange: (status: TelegramStatusView) => void): Promise<() => void>;
}

export interface TelegramSectionOptions {
  group: HTMLElement;
  api: TelegramApi;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}

const CLI_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
];

const PROFILE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["readonly", "Read only — look, never act"],
  ["full", "Full — can type into terminals and change workspaces"],
];

const VOICE_LANGUAGE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["auto", "Detect"],
  ["es", "Spanish"],
  ["en", "English"],
  ["pt", "Portuguese"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
];

/** Accepts ids separated by commas, spaces or new lines; null if any is not one. */
export function parseUserIds(raw: string): number[] | null {
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  const ids: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,15}$/.test(part)) return null;
    const id = Number(part);
    if (id <= 0) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Names separated by commas, trimmed, without empties or repeats. */
export function parseNames(raw: string): string[] {
  const names: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name && !names.some((seen) => seen.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names;
}

export function describeStatus(status: TelegramStatusView): string {
  const bot = status.botUsername ? `@${status.botUsername}` : "bot";
  const ignored = status.ignored > 0 ? ` · ${status.ignored} ignored from unknown senders` : "";
  switch (status.state) {
    case "running":
      return `${bot} is listening${ignored}`;
    case "starting":
      return "Connecting to Telegram…";
    case "error":
      return `Error: ${status.detail}${ignored}`;
    default:
      if (status.detail === "disabled") return "Off. Turn the switch on to start listening.";
      return status.detail ? `Stopped: ${status.detail}` : "Stopped";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function mountTelegramSection(opts: TelegramSectionOptions): Promise<() => void> {
  const { group, api, onError, onMessage } = opts;
  let config = await api.getConfig();

  async function save(patch: TelegramConfigPatch): Promise<boolean> {
    try {
      config = await api.setConfig(patch);
      render();
      return true;
    } catch (error) {
      onError(errorText(error));
      render();
      return false;
    }
  }

  const statusText = document.createElement("span");
  statusText.className = "telegram-status";
  statusText.setAttribute("role", "status");
  const enabled = settingsToggle("Telegram bot", config.enabled, (checked) => {
    void save({ enabled: checked });
  });
  settingsRow(
    group,
    "Telegram bot",
    "Answer messages from a Telegram bot with the operator agent while polakapi is open.",
  ).append(statusText, enabled);

  const token = document.createElement("input");
  token.type = "password";
  token.autocomplete = "off";
  token.spellcheck = false;
  token.className = "telegram-token";
  token.setAttribute("aria-label", "Bot token");
  const saveToken = document.createElement("button");
  saveToken.type = "button";
  saveToken.textContent = "Save";
  const testToken = document.createElement("button");
  testToken.type = "button";
  testToken.textContent = "Test";
  const clearToken = document.createElement("button");
  clearToken.type = "button";
  clearToken.textContent = "Remove";
  saveToken.addEventListener("click", () => {
    const value = token.value.trim();
    if (!value) return;
    void save({ token: value }).then((ok) => {
      if (ok) {
        token.value = "";
        onMessage("Bot token saved.");
      }
    });
  });
  testToken.addEventListener("click", () => {
    testToken.disabled = true;
    api
      .test(token.value.trim() || undefined)
      .then((name) => onMessage(`Telegram accepted the token for ${name}.`))
      .catch((error: unknown) => onError(`Token check failed: ${errorText(error)}`))
      .finally(() => {
        testToken.disabled = false;
      });
  });
  clearToken.addEventListener("click", () => {
    void save({ token: "" }).then((ok) => {
      if (ok) onMessage("Bot token removed.");
    });
  });
  token.addEventListener("input", () => render());
  settingsRow(
    group,
    "Bot token",
    "Create a bot with @BotFather and paste its token. It is stored in a file only your user can read and is never shown again.",
  ).append(token, saveToken, testToken, clearToken);

  const users = document.createElement("input");
  users.type = "text";
  users.className = "telegram-users";
  users.spellcheck = false;
  users.placeholder = "123456789, 987654321";
  users.setAttribute("aria-label", "Allowed user ids");
  users.addEventListener("change", () => {
    const ids = parseUserIds(users.value);
    if (ids === null) {
      onError("Allowed user ids must be numbers separated by commas.");
      return;
    }
    void save({ allowedUserIds: ids });
  });
  settingsRow(
    group,
    "Allowed user ids",
    "Numeric Telegram ids (message @userinfobot to get yours). Messages from anyone else are ignored without a reply. The bot stays off while this is empty.",
  ).append(users);

  const cli = settingsSelect("Agent CLI", CLI_OPTIONS, config.cli, (value) => {
    void save({ cli: value });
  });
  settingsRow(
    group,
    "Agent CLI",
    "Runs headless in polakapi's agent home, one process per message. Each chat keeps its own conversation; /new starts over.",
  ).append(cli);

  const profile = settingsSelect("Tool profile", PROFILE_OPTIONS, config.profile, (value) => {
    void save({ profile: value });
  });
  settingsRow(
    group,
    "Tool profile",
    "Full lets anyone on the allowlist type into your terminals from their phone, which is the same as running commands on this computer.",
  ).append(profile);

  const timeout = settingsNumber(
    "Turn timeout",
    config.turnTimeoutSecs,
    { min: 30, max: 3600 },
    (turnTimeoutSecs) => {
      void save({ turnTimeoutSecs });
    },
  );
  settingsRow(group, "Turn timeout (seconds)", "A turn running longer is killed.").append(timeout);

  const style = document.createElement("textarea");
  style.className = "telegram-style";
  style.rows = 3;
  style.maxLength = 1000;
  style.spellcheck = true;
  style.placeholder = "Answer in Spanish, informal, at most five lines.";
  style.setAttribute("aria-label", "Reply style");
  style.addEventListener("change", () => {
    void save({ replyStyle: style.value.trim() }).then((ok) => {
      if (ok) onMessage("Reply style saved. It applies from the next message.");
    });
  });
  settingsRow(
    group,
    "Reply style",
    "How the agent should write its answers. A chat can override it with /style; /style reset goes back to this.",
  ).append(style);

  const address = document.createElement("input");
  address.type = "text";
  address.className = "telegram-address";
  address.spellcheck = false;
  address.placeholder = "name1, name2, nameN...";
  address.setAttribute("aria-label", "Address me as");
  address.addEventListener("change", () => {
    void save({ addressAs: parseNames(address.value) }).then((ok) => {
      if (ok) onMessage("Saved. The bot uses these names from the next message.");
    });
  });
  settingsRow(
    group,
    "Address me as",
    "Names the bot calls you, separated by commas, so you know an answer is meant for you. With several, it varies between them.",
  ).append(address);

  const confirm = settingsToggle("Ask before acting", config.confirmActions, (checked) => {
    void save({ confirmActions: checked });
  });
  settingsRow(
    group,
    "Ask before acting",
    "When the agent wants to type into a terminal or run a command, the chat gets Run and Cancel buttons. Off: it acts directly. In the chat: /confirm on or off.",
  ).append(confirm);

  const sudo = settingsToggle("Allow sudo", config.allowSudo, (checked) => {
    void save({ allowSudo: checked });
  });
  settingsRow(
    group,
    "Allow sudo",
    "Let commands from Telegram use sudo, doas, su, pkexec or run0. Off, they are refused before anything is typed. Only this switch can change it, not the chat. It cannot see sudo hidden inside an alias, a function or a script. When sudo asks for a password, type it at the computer; the bot never relays it.",
  ).append(sudo);

  const forward = settingsToggle("Agent notifications", config.forwardNotifications, (checked) => {
    void save({ forwardNotifications: checked });
  });
  settingsRow(
    group,
    "Agent notifications",
    "Also send the agent alerts from the App section to the allowed users. Same rules as the desktop alerts. In the chat: /notify on or off.",
  ).append(forward);

  const approvals = settingsToggle("Permission buttons", config.remoteApprovals, (checked) => {
    void save({ remoteApprovals: checked });
  });
  settingsRow(
    group,
    "Permission buttons",
    "Permission alerts from Claude Code get Allow, Always and Deny buttons. polakapi checks the prompt is still on screen before it answers. In the chat: /approvals on or off.",
  ).append(approvals);

  const voice = settingsToggle("Voice notes", config.voiceNotes, (checked) => {
    void save({ voiceNotes: checked });
  });
  const checkVoice = document.createElement("button");
  checkVoice.type = "button";
  checkVoice.textContent = "Check";
  checkVoice.addEventListener("click", () => {
    checkVoice.disabled = true;
    api
      .checkVoice()
      .then((found) => onMessage(`Voice notes ready: ${found}.`))
      .catch((error: unknown) => onError(`Voice notes unavailable: ${errorText(error)}`))
      .finally(() => {
        checkVoice.disabled = false;
      });
  });
  settingsRow(
    group,
    "Voice notes",
    "Transcribe voice notes on this computer with whisper.cpp and ffmpeg, then handle them like typed messages. The audio never leaves this machine. The bot first replies with what it heard.",
  ).append(checkVoice, voice);

  const language = settingsSelect(
    "Voice language",
    VOICE_LANGUAGE_OPTIONS,
    config.voiceLanguage,
    (value) => {
      void save({ voiceLanguage: value });
    },
  );
  settingsRow(
    group,
    "Voice language",
    "Setting the language you speak is faster and more accurate than detecting it.",
  ).append(language);

  const model = document.createElement("input");
  model.type = "text";
  model.className = "telegram-model";
  model.spellcheck = false;
  model.placeholder = "~/.local/share/whisper/ggml-*.bin";
  model.setAttribute("aria-label", "Whisper model");
  model.addEventListener("change", () => {
    void save({ whisperModel: model.value.trim() });
  });
  settingsRow(
    group,
    "Whisper model",
    "Path to a whisper.cpp ggml model. Empty uses the first one in ~/.local/share/whisper.",
  ).append(model);

  function render(): void {
    enabled.checked = config.enabled;
    confirm.checked = config.confirmActions;
    sudo.checked = config.allowSudo;
    sudo.disabled = config.profile !== "full";
    confirm.disabled = config.profile !== "full";
    forward.checked = config.forwardNotifications;
    approvals.checked = config.remoteApprovals;
    approvals.disabled = !config.forwardNotifications;
    token.placeholder = config.hasToken ? `Saved (${config.tokenHint})` : "123456:ABC-DEF…";
    saveToken.disabled = !token.value.trim();
    testToken.disabled = !token.value.trim() && !config.hasToken;
    clearToken.disabled = !config.hasToken;
    if (document.activeElement !== users) users.value = config.allowedUserIds.join(", ");
    cli.value = config.cli;
    profile.value = config.profile;
    if (document.activeElement !== style) style.value = config.replyStyle;
    voice.checked = config.voiceNotes;
    language.value = config.voiceLanguage;
    language.disabled = !config.voiceNotes;
    model.disabled = !config.voiceNotes;
    if (document.activeElement !== model) model.value = config.whisperModel;
    if (document.activeElement !== address) address.value = config.addressAs.join(", ");
    timeout.value = String(config.turnTimeoutSecs);
    timeout.dataset.current = String(config.turnTimeoutSecs);
  }

  const showStatus = (status: TelegramStatusView): void => {
    statusText.textContent = describeStatus(status);
    statusText.classList.toggle("is-error", status.state === "error");
  };
  render();
  showStatus(await api.getStatus());
  return api.watchStatus(showStatus);
}
