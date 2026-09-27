import { describe, expect, it } from "vitest";
import type { ReviewProcess } from "../types";
import { clearsReviewFolder, processRows, processesMessage } from "./review-run-model";

function process(overrides: Partial<ReviewProcess> & Pick<ReviewProcess, "number" | "slug">) {
  return { markdown: null, html: null, verdict: "pending", ...overrides } satisfies ReviewProcess;
}

describe("clearsReviewFolder", () => {
  it("clears the previous run when Step 1 starts", () => {
    expect(clearsReviewFolder("step1")).toBe(true);
  });
});

describe("processesMessage", () => {
  it("explains each state without processes", () => {
    expect(processesMessage({ kind: "loading" })).toBe("Loading processes…");
    expect(processesMessage({ kind: "error", message: "HEAD is detached" })).toBe(
      "HEAD is detached",
    );
    expect(
      processesMessage({ kind: "loaded", branch: "main", folder: "docs/x", processes: [] }),
    ).toBe("No review run yet");
  });

  it("is empty once processes exist", () => {
    const loaded = {
      kind: "loaded" as const,
      branch: "main",
      folder: "docs/x",
      processes: [process({ number: "1.1", slug: "a", markdown: "1.1-a.md" })],
    };

    expect(processesMessage(loaded)).toBeNull();
  });
});

describe("processRows", () => {
  it("labels each process with its number, name and verdict badge", () => {
    const rows = processRows([
      process({ number: "1.1", slug: "login-form", markdown: "1.1-login-form.md" }),
      process({ number: "1.2", slug: "sync", html: "1.2-sync.html", verdict: "go" }),
      process({ number: "2.1", slug: "cache", html: "2.1-cache.html", verdict: "no-go" }),
    ]);

    expect(rows).toEqual([
      { key: "1.1-login-form", label: "1.1 login-form", badge: "pending" },
      { key: "1.2-sync", label: "1.2 sync", badge: "GO" },
      { key: "2.1-cache", label: "2.1 cache", badge: "NO-GO" },
    ]);
  });
});
