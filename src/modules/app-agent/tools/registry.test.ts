import { describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/tauri/invoke", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("invoke not available in tests"))),
  InvokeError: class InvokeError extends Error {},
}));
vi.mock("../../../shared/persistence/workspaces-store", () => ({
  flushSaveWorkspaces: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../terminal/pty-client", () => ({ ptyWrite: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock("../../settings/context-mode-preferences", () => ({
  CONTEXT_MODE_CLIS: [],
  loadContextMode: vi.fn(),
  saveContextMode: vi.fn(),
}));
vi.mock("../adversarial-runner", () => ({
  AdversarialRunner: class {},
  AdversarialRunnerError: class extends Error {},
  isLoopCli: () => true,
}));

import { allTools, createToolRegistry, READONLY_TOOLS } from "./registry";
import type { ToolContext } from "./types";

const ctx = {
  getController: () => null,
  router: {} as ToolContext["router"],
  adversarial: {} as ToolContext["adversarial"],
} satisfies ToolContext;

describe("tool registry", () => {
  it("exposes uniquely named, prefixed tools with object schemas", () => {
    const names = allTools().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of allTools()) {
      expect(tool.name).toMatch(/^polakapi_[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      for (const required of tool.inputSchema.required ?? []) {
        expect(tool.inputSchema.properties).toHaveProperty(required);
      }
    }
  });

  it("lists descriptors without handlers", () => {
    const listed = createToolRegistry(ctx).list();
    expect(listed.length).toBe(allTools().length);
    expect(listed.some((tool) => tool.name === "polakapi_overview")).toBe(true);
    expect(Object.keys(listed[0])).toEqual(["name", "description", "inputSchema"]);
  });

  it("turns unknown tools and ToolErrors into error results", async () => {
    const registry = createToolRegistry(ctx);
    expect(await registry.call("nope", {})).toEqual({ text: "unknown tool: nope", isError: true });
    const notReady = await registry.call("polakapi_overview", {});
    expect(notReady.isError).toBe(true);
    expect(notReady.text).toMatch(/still loading/);
  });

  it("validates arguments before touching the app", async () => {
    const registry = createToolRegistry(ctx);
    const result = await registry.call("polakapi_read_terminal", { lines: 5 });
    expect(result).toEqual({ text: '"ptyId" is required', isError: true });
    const bad = await registry.call("polakapi_send_to_terminal", "not-an-object");
    expect(bad.isError).toBe(true);
  });

  it("limits the readonly profile to tools that only read", async () => {
    const registry = createToolRegistry(ctx);
    const names = new Set(allTools().map((tool) => tool.name));
    for (const name of READONLY_TOOLS) expect(names.has(name)).toBe(true);
    const listed = registry.list("readonly").map((tool) => tool.name);
    expect(listed.length).toBe(READONLY_TOOLS.size);
    expect(listed).not.toContain("polakapi_send_to_terminal");
    const refused = await registry.call("polakapi_send_to_terminal", {}, "readonly");
    expect(refused).toEqual({
      text: "polakapi_send_to_terminal is not available in the readonly profile",
      isError: true,
    });
  });
});
