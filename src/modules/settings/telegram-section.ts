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
}

export type TelegramConfigPatch = Partial<
  Pick<TelegramConfigView, "enabled" | "allowedUserIds" | "cli" | "profile" | "turnTimeoutSecs">
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
      return status.detail && status.detail !== "disabled"
        ? `Stopped: ${status.detail}`
        : "Stopped";
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

  function render(): void {
    enabled.checked = config.enabled;
    token.placeholder = config.hasToken ? `Saved (${config.tokenHint})` : "123456:ABC-DEF…";
    saveToken.disabled = !token.value.trim();
    testToken.disabled = !token.value.trim() && !config.hasToken;
    clearToken.disabled = !config.hasToken;
    if (document.activeElement !== users) users.value = config.allowedUserIds.join(", ");
    cli.value = config.cli;
    profile.value = config.profile;
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
