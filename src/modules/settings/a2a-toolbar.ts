import { watchAgentCommunication, type AgentCommunicationSettings } from "./agent-communication";
import { invoke } from "../../shared/tauri/invoke";
import { showToast } from "../../shared/ui/toast";

/** Keeps the toolbar shortcut synchronized with the native A2A preference. */
export async function wireAgentCommunicationToggle(): Promise<void> {
  const button = document.getElementById("toggle-agent-communication");
  if (!(button instanceof HTMLButtonElement)) return;
  const target = button;

  let settings: AgentCommunicationSettings;
  try {
    await watchAgentCommunication((current) => {
      settings = current;
      render();
    });
  } catch (error) {
    showToast(`Could not load agent communication settings: ${String(error)}`, "error");
    return;
  }

  let saving = Promise.resolve();
  button.addEventListener("click", () => {
    target.setAttribute("aria-busy", "true");
    saving = saving
      .catch(() => {})
      .then(async () => {
        settings = await invoke<AgentCommunicationSettings>("a2a_update_settings", {
          enabled: !settings.enabled,
        });
        render();
      });
    void saving
      .catch(() => {
        // invoke() already surfaces the native error; refresh to restore native state.
        return invoke<AgentCommunicationSettings>("a2a_settings").then((current) => {
          settings = current;
          render();
        });
      })
      .catch(() => {})
      .finally(() => target.removeAttribute("aria-busy"));
  });

  function render(): void {
    target.classList.toggle("active", settings.enabled);
    target.setAttribute("aria-pressed", String(settings.enabled));
    target.title = settings.enabled
      ? `Disable agent communication (${settings.scope === "window" ? "this window" : "all windows"}) and revoke context access`
      : "Enable agent communication";
  }
}
