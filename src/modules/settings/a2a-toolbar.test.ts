import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as InvokeModule from "../../shared/tauri/invoke";

vi.mock("../../shared/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof InvokeModule>()),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { listen } from "@tauri-apps/api/event";
import { invoke } from "../../shared/tauri/invoke";
import { wireAgentCommunicationToggle } from "./a2a-toolbar";

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<button id="toggle-agent-communication"></button>';
  vi.mocked(invoke).mockImplementation((command: string) => {
    if (command === "a2a_settings") return Promise.resolve({ enabled: false, scope: "window" });
    if (command === "a2a_update_settings")
      return Promise.resolve({ enabled: true, scope: "window" });
    return Promise.resolve(undefined);
  });
});

describe("agent communication toolbar toggle", () => {
  it("loads and toggles the persisted setting without changing the awake control", async () => {
    await wireAgentCommunicationToggle();
    const button = document.querySelector<HTMLButtonElement>("#toggle-agent-communication")!;
    expect(button.getAttribute("aria-pressed")).toBe("false");
    button.click();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("a2a_update_settings", { enabled: true }),
    );
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});

it("keeps a Settings change made while the toolbar is loading and can turn it off", async () => {
  let announce: ((enabled: boolean) => void) | undefined;
  vi.mocked(listen).mockImplementationOnce((_name, handler) => {
    announce = (enabled) =>
      handler({ event: "a2a:settings", id: 1, payload: { enabled, scope: "window" } });
    return Promise.resolve(() => {});
  });
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "a2a_settings") announce?.(true);
    return Promise.resolve({ enabled: false, scope: "window" });
  });
  await wireAgentCommunicationToggle();
  const button = document.querySelector<HTMLButtonElement>("#toggle-agent-communication")!;
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.title).toMatch(/revoke/i);
  button.click();
  await vi.waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("false"));
  expect(invoke).toHaveBeenCalledWith("a2a_update_settings", { enabled: false });
  expect(invoke).not.toHaveBeenCalledWith("a2a_review_share", expect.anything());
});
