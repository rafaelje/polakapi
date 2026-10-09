import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { invoke } from "../../shared/tauri/invoke";
import { toProfile, type ToolRegistry } from "./tools/registry";
import type { ControlRequest } from "./types";

// Answers the control server's relayed requests. One listener per main
// window; the Rust side refuses requests while no bridge is mounted.

const REQUEST_EVENT = "app-control:request";

/** Control methods that are not model tools, e.g. answers coming from Telegram. */
export type ControlMethods = Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

export interface ControlBridgeHandle {
  dispose(): Promise<void>;
}

function isControlRequest(value: unknown): value is ControlRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ControlRequest>;
  return typeof candidate.id === "number" && typeof candidate.method === "string";
}

async function dispatch(
  registry: ToolRegistry,
  methods: ControlMethods,
  request: ControlRequest,
): Promise<unknown> {
  const params = (request.params ?? {}) as {
    name?: unknown;
    arguments?: unknown;
    profile?: unknown;
  };
  const profile = toProfile(params.profile);
  switch (request.method) {
    case "tools.list":
      return { tools: registry.list(profile) };
    case "tools.call": {
      if (typeof params.name !== "string") throw new Error("tools.call needs a name");
      return registry.call(params.name, params.arguments, profile);
    }
    default: {
      const method = Object.prototype.hasOwnProperty.call(methods, request.method)
        ? methods[request.method]
        : undefined;
      if (!method) throw new Error(`unknown control method: ${request.method}`);
      return method(params);
    }
  }
}

async function respond(id: number, ok: boolean, payload: unknown): Promise<void> {
  try {
    await invoke("app_control_respond", { id, ok, payload }, { toastOnError: false });
  } catch (error) {
    console.error("app-agent: could not deliver control response", error);
  }
}

export async function mountControlBridge(
  registry: ToolRegistry,
  methods: ControlMethods = {},
): Promise<ControlBridgeHandle> {
  let disposed = false;
  const unlisten: UnlistenFn = await listen<unknown>(REQUEST_EVENT, (event) => {
    if (disposed || !isControlRequest(event.payload)) return;
    const request = event.payload;
    void dispatch(registry, methods, request).then(
      (result) => respond(request.id, true, result),
      (error: unknown) => respond(request.id, false, String(error)),
    );
  });
  try {
    await invoke("app_control_set_ready", { ready: true }, { toastOnError: false });
  } catch (error) {
    console.error("app-agent: control server unavailable", error);
  }
  return {
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      unlisten();
      try {
        await invoke("app_control_set_ready", { ready: false }, { toastOnError: false });
      } catch {
        // The app is shutting down; the server dies with it.
      }
    },
  };
}
