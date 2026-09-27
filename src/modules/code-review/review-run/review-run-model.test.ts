import { describe, expect, it } from "vitest";
import type { ReviewProcess } from "../types";
import {
  clearsReviewFolder,
  processRows,
  processesMessage,
  reconcileReport,
  reviewersModelOverride,
  reviewersModelValue,
  type ProcessesState,
} from "./review-run-model";

function process(overrides: Partial<ReviewProcess> & Pick<ReviewProcess, "number" | "slug">) {
  return { markdown: null, html: null, verdict: "pending", ...overrides } satisfies ReviewProcess;
}

function loaded(processes: ReviewProcess[], index: string | null = null): ProcessesState {
  return { kind: "loaded", branch: "main", folder: "docs/x", processes, index };
}

describe("clearsReviewFolder", () => {
  it("clears the previous run when Step 1 or Both starts, but keeps it for Step 2", () => {
    expect(clearsReviewFolder("step1")).toBe(true);
    expect(clearsReviewFolder("both")).toBe(true);
    expect(clearsReviewFolder("step2")).toBe(false);
  });
});

describe("processesMessage", () => {
  it("explains each state without processes", () => {
    expect(processesMessage({ kind: "loading" })).toBe("Loading processes…");
    expect(processesMessage({ kind: "error", message: "HEAD is detached" })).toBe(
      "HEAD is detached",
    );
    expect(processesMessage(loaded([]))).toBe("No review run yet");
  });

  it("is empty once processes exist", () => {
    expect(
      processesMessage(loaded([process({ number: "1.1", slug: "a", markdown: "1.1-a.md" })])),
    ).toBeNull();
  });
});

describe("processRows", () => {
  it("labels each process with its number, name, verdict badge and report", () => {
    const rows = processRows([
      process({ number: "1.1", slug: "login-form", markdown: "1.1-login-form.md" }),
      process({ number: "1.2", slug: "sync", html: "1.2-sync.html", verdict: "go" }),
      process({ number: "2.1", slug: "cache", html: "2.1-cache.html", verdict: "no-go" }),
    ]);

    expect(rows).toEqual([
      { key: "1.1-login-form", label: "1.1 login-form", badge: "pending", report: null },
      { key: "1.2-sync", label: "1.2 sync", badge: "GO", report: "1.2-sync.html" },
      { key: "2.1-cache", label: "2.1 cache", badge: "NO-GO", report: "2.1-cache.html" },
    ]);
  });
});

describe("reviewers' model", () => {
  it("follows the terminal model until the user types another one", () => {
    expect(reviewersModelValue(null, "claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(reviewersModelValue("claude-haiku-4-5", "claude-opus-4-7")).toBe("claude-haiku-4-5");
  });

  it("goes back to following the terminal when cleared or set to the terminal model", () => {
    expect(reviewersModelOverride(" claude-haiku-4-5 ", "claude-opus-4-7")).toBe(
      "claude-haiku-4-5",
    );
    expect(reviewersModelOverride("  ", "claude-opus-4-7")).toBeNull();
    expect(reviewersModelOverride("claude-opus-4-7", "claude-opus-4-7")).toBeNull();
  });
});

describe("reconcileReport", () => {
  const state = loaded(
    [process({ number: "1.1", slug: "a", html: "1.1-a.html", verdict: "go" })],
    "index.html",
  );

  it("keeps an open report that still exists", () => {
    expect(reconcileReport("1.1-a.html", state)).toBe("1.1-a.html");
    expect(reconcileReport("index.html", state)).toBe("index.html");
  });

  it("closes a report that disappeared", () => {
    expect(reconcileReport("1.2-b.html", state)).toBeNull();
    expect(reconcileReport("index.html", loaded([]))).toBeNull();
    expect(reconcileReport(null, state)).toBeNull();
  });

  it("keeps the open report while the list is loading or failing", () => {
    expect(reconcileReport("1.1-a.html", { kind: "loading" })).toBe("1.1-a.html");
    expect(reconcileReport("1.1-a.html", { kind: "error", message: "x" })).toBe("1.1-a.html");
  });
});
