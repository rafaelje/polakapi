import { listen } from "@tauri-apps/api/event";
import { invoke } from "../../shared/tauri/invoke";

export interface AgentCommunicationSettings {
  enabled: boolean;
  scope: "window" | "all";
}

export async function watchAgentCommunication(
  render: (settings: AgentCommunicationSettings) => void,
): Promise<void> {
  let changes = 0;
  const unlisten = await listen<AgentCommunicationSettings>("a2a:settings", ({ payload }) => {
    changes++;
    render(payload);
  });
  const before = changes;
  try {
    const initial = await invoke<AgentCommunicationSettings>("a2a_settings");
    if (changes === before) render(initial);
  } catch (error) {
    unlisten();
    throw error;
  }
}
