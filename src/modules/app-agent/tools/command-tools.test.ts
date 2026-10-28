import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  calls: [] as unknown[][],
  answer: (): Promise<unknown> => Promise.resolve(undefined),
}));
vi.mock("../../../shared/tauri/invoke", () => ({
  invoke: (...args: unknown[]) => {
    mocked.calls.push(args);
    return mocked.answer();
  },
}));

import { commandTools } from "./command-tools";
import type { ToolContext } from "./types";

const project = { id: "p1", name: "polakapi", path: "/w/polakapi" };
const ctx = {
  getController: () => ({
    getState: () => ({
      activeProjectId: "p1",
      workspaces: [{ id: "w1", name: "work", projects: [project], folders: [] }],
    }),
  }),
  router: {},
  adversarial: {},
} as unknown as ToolContext;

const runTool = commandTools.find((tool) => tool.name === "polakapi_run_command")!;
const run = (args: Record<string, unknown>) => runTool.run(args, ctx);

beforeEach(() => {
  mocked.calls.length = 0;
});

describe("polakapi_run_command", () => {
  it("runs in the project's folder and returns the transcript", async () => {
    mocked.answer = () =>
      Promise.resolve({ transcript: "$ git status\nOn branch main", exitCode: 0 });
    await expect(run({ command: "git status" })).resolves.toBe("$ git status\nOn branch main");
    expect(mocked.calls).toEqual([
      ["app_run_command", { cwd: "/w/polakapi", command: "git status" }, { toastOnError: false }],
    ]);
  });

  it("reports failures to the model", async () => {
    mocked.answer = () => Promise.reject(new Error("the shell is gone"));
    await expect(run({ project: "polakapi", command: "ls" })).rejects.toThrow(
      /could not run the command: Error: the shell is gone/,
    );
    await expect(run({})).rejects.toThrow(/command/);
  });
});
