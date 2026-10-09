import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Array<(event: { payload: unknown }) => void> = [];
const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve(undefined));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.push(handler);
    return Promise.resolve(() => {
      listeners.splice(listeners.indexOf(handler), 1);
    });
  }),
}));
vi.mock("../../shared/tauri/invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { mountControlBridge } from "./control-bridge";
import type { ToolRegistry } from "./tools/registry";

const registry: ToolRegistry = {
  list: () => [
    {
      name: "polakapi_overview",
      description: "d",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  call: (name, args) =>
    Promise.resolve({ text: `${name}:${JSON.stringify(args)}`, isError: false }),
};

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("control bridge", () => {
  beforeEach(() => {
    listeners.length = 0;
    invoke.mockClear();
  });

  it("marks the bridge ready and answers tools.list and tools.call", async () => {
    const bridge = await mountControlBridge(registry);
    expect(invoke).toHaveBeenCalledWith(
      "app_control_set_ready",
      { ready: true },
      { toastOnError: false },
    );

    listeners[0]({ payload: { id: 1, method: "tools.list", params: {} } });
    listeners[0]({
      payload: {
        id: 2,
        method: "tools.call",
        params: { name: "polakapi_overview", arguments: { a: 1 } },
      },
    });
    await flush();

    expect(invoke).toHaveBeenCalledWith(
      "app_control_respond",
      { id: 1, ok: true, payload: { tools: registry.list() } },
      { toastOnError: false },
    );
    expect(invoke).toHaveBeenCalledWith(
      "app_control_respond",
      { id: 2, ok: true, payload: { text: 'polakapi_overview:{"a":1}', isError: false } },
      { toastOnError: false },
    );

    await bridge.dispose();
    expect(listeners).toHaveLength(0);
    expect(invoke).toHaveBeenCalledWith(
      "app_control_set_ready",
      { ready: false },
      { toastOnError: false },
    );
  });

  it("forwards the caller's tool profile and defaults to full", async () => {
    const list = vi.fn(() => []);
    const call = vi.fn(() => Promise.resolve({ text: "ok", isError: false }));
    await mountControlBridge({ list, call });
    listeners[0]({ payload: { id: 4, method: "tools.list", params: { profile: "readonly" } } });
    listeners[0]({
      payload: { id: 5, method: "tools.call", params: { name: "x", profile: "root" } },
    });
    await flush();
    expect(list).toHaveBeenCalledWith("readonly");
    expect(call).toHaveBeenCalledWith("x", undefined, "full");
  });

  it("rejects unknown methods and ignores malformed payloads", async () => {
    await mountControlBridge(registry);
    listeners[0]({ payload: { id: 3, method: "bogus" } });
    listeners[0]({ payload: "garbage" });
    await flush();
    expect(invoke).toHaveBeenCalledWith(
      "app_control_respond",
      { id: 3, ok: false, payload: "Error: unknown control method: bogus" },
      { toastOnError: false },
    );
    const responses = invoke.mock.calls.filter((call) => call[0] === "app_control_respond");
    expect(responses).toHaveLength(1);
  });
});
