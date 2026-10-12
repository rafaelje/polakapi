// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSummary, ContextDetail } from "./types";
const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => transport);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const agent: AgentSummary = {
  ptyId: "pane",
  cli: "claude",
  cwd: "/fixture",
  project: "fixture",
  model: null,
  contextTokens: 0,
  contextLimit: 0,
  readable: true,
  process: { rssMb: 0, cpuPercent: 0, uptimeSecs: 0, pid: null },
};
const snapshot = {
  summary: agent,
  identity: { sessionId: "A", transcriptPath: "/fixture/A.jsonl" },
  breakdown: { instructions: 0, files: 0, toolOutput: 0, messages: 1, thinking: 0 },
  entries: [
    {
      id: 0,
      kind: "user-prompt",
      label: "old A",
      detail: null,
      timestamp: null,
      chars: 600,
      estTokens: 150,
      preview: "old preview",
      truncated: true,
    },
  ],
  note: null,
};
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function click(selector: string) {
  document.querySelector<HTMLButtonElement>(selector)!.click();
}
beforeEach(() => {
  vi.resetModules();
  transport.invoke.mockReset();
  document.body.innerHTML =
    '<div id="ctx-list"></div><div id="ctx-detail"></div><span id="ctx-counter"></span><button id="ctx-refresh"></button><input id="ctx-search">';
});
afterEach(() => vi.useRealTimers());
it("search carries snapshot identity and input immediately invalidates pending results", async () => {
  vi.useFakeTimers();
  const pending = deferred<unknown[]>();
  transport.invoke.mockImplementation((command: string) => {
    if (command === "agent_context_list") return Promise.resolve([agent]);
    if (command === "agent_context_detail") return Promise.resolve(snapshot);
    return pending.promise;
  });
  await import("./context");
  await settle();
  click(".ctx-row");
  await settle();
  const input = document.querySelector<HTMLInputElement>("#ctx-search")!;
  input.value = "old";
  input.dispatchEvent(new Event("input"));
  await vi.advanceTimersByTimeAsync(250);
  expect(transport.invoke).toHaveBeenCalledWith("agent_context_search", {
    ptyId: "pane",
    pattern: "old",
    identity: snapshot.identity,
  });
  input.value = "new";
  input.dispatchEvent(new Event("input"));
  pending.resolve([]);
  await settle();
  expect(document.querySelector(".ctx-entry-body")?.textContent).toBe("old preview");
});
it("late entry reads cannot replace the refreshed snapshot", async () => {
  const pending = deferred<string>();
  let latest = snapshot;
  transport.invoke.mockImplementation((command: string) => {
    if (command === "agent_context_list") return Promise.resolve([agent]);
    if (command === "agent_context_detail") return Promise.resolve(latest);
    return pending.promise;
  });
  await import("./context");
  await settle();
  click(".ctx-row");
  await settle();
  click(".ctx-more");
  latest = {
    ...snapshot,
    identity: { sessionId: "B", transcriptPath: "/fixture/B.jsonl" },
    entries: [{ ...snapshot.entries[0], preview: "new preview" }],
  };
  click("#ctx-refresh");
  await settle();
  pending.resolve("old full body");
  await settle();
  expect(document.querySelector(".ctx-entry-body")?.textContent).toBe("new preview");
});
it("a session change while loading detail retries with a new snapshot", async () => {
  transport.invoke
    .mockResolvedValueOnce([agent])
    .mockRejectedValueOnce("STALE_CONTEXT")
    .mockResolvedValueOnce(snapshot);
  await import("./context");
  await settle();
  click(".ctx-row");
  await settle();
  expect(document.querySelector(".ctx-entry-body")?.textContent).toBe("old preview");
  expect(
    transport.invoke.mock.calls.filter(([command]) => command === "agent_context_detail"),
  ).toHaveLength(2);
});
it("the newest list wins over an older refresh and its continuation", async () => {
  const old = deferred<AgentSummary[]>();
  const latest = deferred<AgentSummary[]>();
  transport.invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  await import("./context");
  click("#ctx-refresh");
  latest.resolve([]);
  await settle();
  old.resolve([agent]);
  await settle();
  expect(document.querySelector("#ctx-counter")!.textContent).toBe("0 agents running");
  expect(document.querySelector(".ctx-row")).toBeNull();
});
it("an older list failure cannot replace the latest list", async () => {
  const old = deferred<AgentSummary[]>();
  transport.invoke.mockReturnValueOnce(old.promise).mockResolvedValueOnce([agent]);
  await import("./context");
  click("#ctx-refresh");
  await settle();
  old.reject("old failure");
  await settle();
  expect(document.querySelector(".ctx-row")).not.toBeNull();
});
it("entry reads carry the displayed identity and stale context reloads without mixing bodies", async () => {
  const reload = deferred<ContextDetail>();
  transport.invoke.mockImplementation((command: string) => {
    if (command === "agent_context_list") return Promise.resolve([agent]);
    if (command === "agent_context_detail") return Promise.resolve(snapshot);
    return Promise.reject(new Error("STALE_CONTEXT"));
  });
  await import("./context");
  await settle();
  click(".ctx-row");
  await settle();
  transport.invoke.mockImplementation((command: string) => {
    if (command === "agent_context_detail") return reload.promise;
    return Promise.reject(new Error("STALE_CONTEXT"));
  });
  click(".ctx-more");
  await settle();
  expect(transport.invoke).toHaveBeenCalledWith("agent_context_entry", {
    ptyId: "pane",
    entryId: 0,
    identity: snapshot.identity,
  });
  expect(document.querySelector("#ctx-detail")!.textContent).toContain("Reading context");
  expect(document.querySelector("#ctx-detail")!.textContent).not.toContain("old preview");
  reload.resolve({ ...snapshot, entries: [], note: "fresh B" });
  await settle();
  expect(document.querySelector("#ctx-detail")!.textContent).toContain("fresh B");
});
