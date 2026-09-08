import { open } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { invoke } from "../../shared/tauri/invoke";
import { loadPreferences, savePreferences, type NotificationPreferences } from "./preferences";
import { deliverNotification } from "./notifications";
import "./settings.css";

interface SystemSound {
  name: string;
  path: string;
}

async function start(): Promise<void> {
  const host = document.querySelector<HTMLDivElement>("#settings")!;
  host.innerHTML = `<aside><h1>Settings</h1><div class="selected" aria-current="page"><span aria-hidden="true">⚙</span> App</div></aside>
    <main><h2>App</h2><div class="settings-group"></div><p class="settings-note">Agent alerts require CLI hooks. Permission and input alerts are available for Claude; completion alerts work with Claude and Codex hooks. Restart agent sessions after enabling hooks.</p><p class="settings-status" role="status"></p></main>`;
  const group = host.querySelector<HTMLDivElement>(".settings-group")!;
  const status = host.querySelector<HTMLParagraphElement>(".settings-status")!;
  let p = await loadPreferences();
  let saving = Promise.resolve();
  function save(patch: Partial<NotificationPreferences>): void {
    p = { ...p, ...patch };
    const snapshot = { ...p };
    saving = saving.catch(() => {}).then(() => savePreferences(snapshot));
    void saving.then(
      () => {
        status.textContent = "";
      },
      () => {
        status.textContent = "Could not save settings. Try changing the setting again.";
      },
    );
  }
  function action(operation: () => Promise<unknown>): void {
    void operation().catch((error: unknown) => {
      status.textContent = error instanceof Error ? error.message : String(error);
    });
  }
  function row(title: string, description: string): HTMLDivElement {
    const element = document.createElement("section");
    element.className = "settings-row";
    const copy = document.createElement("div");
    const label = document.createElement("h3");
    label.textContent = title;
    const help = document.createElement("p");
    help.textContent = description;
    copy.append(label, help);
    const controls = document.createElement("div");
    controls.className = "settings-controls";
    element.append(copy, controls);
    group.append(element);
    return controls;
  }
  function toggle(
    title: string,
    checked: boolean,
    change: (checked: boolean) => void,
  ): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.role = "switch";
    input.className = "settings-switch";
    input.checked = checked;
    input.setAttribute("aria-label", title);
    input.addEventListener("change", () => change(input.checked));
    return input;
  }
  function button(label: string, click: () => unknown): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => {
      b.disabled = true;
      action(async () => {
        try {
          await click();
        } finally {
          b.disabled = false;
        }
      });
    });
    return b;
  }
  host.querySelector(".settings-note")!.append(
    " ",
    button("Enable agent hooks", async () => {
      await invoke("prompt_install_hooks", { cli: "claude" });
      await invoke("prompt_install_hooks", { cli: "codex" });
      status.textContent =
        "Hooks enabled. Restart existing Claude and Codex sessions to load them.";
    }),
  );
  row(
    "Agent Needs Permission",
    "Notify when an agent is waiting for your permission to run a tool.",
  ).append(toggle("Agent Needs Permission", p.permission, (permission) => save({ permission })));
  const finished = document.createElement("select");
  finished.setAttribute("aria-label", "Agent Finished");
  for (const [value, label] of [
    ["never", "Never"],
    ["immediately", "Immediately"],
    ["idle", "When idle"],
  ])
    finished.add(new Option(label, value));
  finished.value = p.finished;
  finished.addEventListener("change", () =>
    save({ finished: finished.value as NotificationPreferences["finished"] }),
  );
  row("Agent Finished", "When idle waits until all tracked agents have stopped working.").append(
    finished,
  );
  row(
    "Agent Waiting for Input",
    "Notify when an agent is idle and needs input. Suppressed while another tracked agent is working.",
  ).append(toggle("Agent Waiting for Input", p.waiting, (waiting) => save({ waiting })));
  const desktop = row(
    "Desktop Notifications",
    "Show notifications in your system notification center.",
  );
  const permission = document.createElement("span");
  permission.className = "permission-status";
  async function refreshPermission(): Promise<void> {
    const granted = await isPermissionGranted();
    permission.textContent = granted ? "Allowed" : "Not allowed";
    permission.classList.toggle("allowed", granted);
  }
  desktop.append(
    toggle("Desktop Notifications", p.desktop, (desktop) => save({ desktop })),
    permission,
    button("Open System Settings", () => invoke("notification_open_settings")),
    button("Send Test", async () => {
      await requestPermission();
      await refreshPermission();
      await deliverNotification("polakapi", "Your agent notifications are ready.", {
        ...p,
        desktop: true,
      });
      status.textContent =
        "Test sent. Your system’s Focus and notification settings control banner visibility.";
    }),
  );
  window.addEventListener("focus", () => action(refreshPermission));
  action(refreshPermission);
  const soundControls = row(
    "Notification Sound",
    "Play a system sound or your own audio file when a notification arrives.",
  );
  const sound = document.createElement("select");
  sound.setAttribute("aria-label", "Notification Sound");
  sound.add(new Option("System Default", "default"));
  sound.add(new Option("None", "none"));
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Custom File…";
  sound.append(custom);
  const filename = document.createElement("span");
  filename.className = "sound-filename";
  const sounds = await invoke<SystemSound[]>("notification_sounds");
  const systemGroup = document.createElement("optgroup");
  systemGroup.label = "System Sounds";
  for (const entry of sounds) systemGroup.append(new Option(entry.name, entry.path));
  sound.append(systemGroup);
  function renderSound(): void {
    const isCustom = !["none", "default", ...sounds.map((s) => s.path)].includes(p.sound);
    sound.value = isCustom ? "custom" : p.sound;
    filename.textContent = isCustom ? (p.sound.split(/[\\/]/).pop() ?? p.sound) : "";
    filename.title = isCustom ? p.sound : "";
    preview.disabled = p.sound === "none";
    clear.disabled = p.sound === "default";
  }
  async function choose(): Promise<void> {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Audio",
          extensions: navigator.userAgent.includes("Windows")
            ? ["wav"]
            : ["aiff", "aif", "wav", "mp3", "ogg", "oga", "m4a", "caf"],
        },
      ],
    });
    if (typeof path === "string") save({ sound: path });
    renderSound();
  }
  sound.addEventListener("change", () => {
    if (sound.value === "custom")
      action(async () => {
        try {
          await choose();
        } finally {
          renderSound();
        }
      });
    else {
      save({ sound: sound.value });
      renderSound();
    }
  });
  const preview = button("▶", async () => {
    if (p.sound === "default")
      await deliverNotification("polakapi", "Notification sound preview", {
        ...p,
        desktop: true,
        command: "",
      });
    else await invoke("notification_play_sound", { path: p.sound });
  });
  preview.setAttribute("aria-label", "Preview notification sound");
  const clear = button("Clear", () => {
    save({ sound: "default" });
    renderSound();
  });
  soundControls.append(sound, preview, filename, button("Choose…", choose), clear);
  renderSound();
  const command = document.createElement("input");
  command.type = "text";
  command.className = "command-input";
  command.placeholder = 'say "done"';
  command.value = p.command;
  command.setAttribute("aria-label", "Notification Command");
  command.addEventListener("change", () => save({ command: command.value }));
  row(
    "Notification Command",
    "Run a shell command on notification. POLAKAPI_NOTIFICATION_TITLE and POLAKAPI_NOTIFICATION_BODY are available as environment variables.",
  ).append(command);
}

void start().catch((error: unknown) => {
  const status = document.querySelector(".settings-status");
  if (status) status.textContent = `Could not load settings: ${String(error)}`;
});
