import { describe, expect, it } from "vitest";
import type { ReviewProcess } from "../types";
import {
  clearsReviewFolder,
  processRows,
  processesMessage,
  reconcileProcess,
  reportPath,
  reviewersModelOverride,
  reviewersModelValue,
  selectedReport,
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
  it("labels each process with its number, name, verdict badge and file", () => {
    const rows = processRows([
      process({ number: "1.1", slug: "login-form", markdown: "1.1-login-form.md" }),
      process({ number: "1.2", slug: "sync", html: "1.2-sync.html", verdict: "go" }),
      process({ number: "2.1", slug: "cache", html: "2.1-cache.html", verdict: "no-go" }),
    ]);

    expect(rows).toEqual([
      {
        key: "1.1-login-form",
        label: "1.1 login-form",
        badge: "pending",
        file: "1.1-login-form.md",
      },
      { key: "1.2-sync", label: "1.2 sync", badge: "GO", file: "1.2-sync.html" },
      { key: "2.1-cache", label: "2.1 cache", badge: "NO-GO", file: "2.1-cache.html" },
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

describe("reportPath", () => {
  it("joins the project root, review folder and file", () => {
    expect(reportPath("/home/me/app", "docs/code-review/feat-x", "1.1-a.html")).toBe(
      "/home/me/app/docs/code-review/feat-x/1.1-a.html",
    );
    expect(reportPath("/home/me/app/", "docs/code-review/main", "index.html")).toBe(
      "/home/me/app/docs/code-review/main/index.html",
    );
  });

  it("uses backslashes for Windows project paths", () => {
    expect(reportPath("C:\\repos\\app\\", "docs/code-review/main", "1.1-a.md")).toBe(
      "C:\\repos\\app\\docs\\code-review\\main\\1.1-a.md",
    );
  });
});

describe("selectedReport", () => {
  const state = loaded(
    [
      process({
        number: "1.1",
        slug: "a",
        markdown: "1.1-a.md",
        html: "1.1-a.html",
        verdict: "go",
      }),
      process({ number: "1.2", slug: "b", markdown: "1.2-b.md" }),
    ],
    "index.html",
  );

  it("points to the HTML report of a process", () => {
    expect(selectedReport("1.1-a", state, "/p")).toEqual({
      label: "1.1 a",
      path: "/p/docs/x/1.1-a.html",
    });
  });

  it("falls back to the markdown file while the HTML does not exist", () => {
    expect(selectedReport("1.2-b", state, "/p")).toEqual({
      label: "1.2 b",
      path: "/p/docs/x/1.2-b.md",
    });
  });

  it("points to the index", () => {
    expect(selectedReport("index", state, "/p")).toEqual({
      label: "index",
      path: "/p/docs/x/index.html",
    });
  });

  it("is empty without a selection, a matching process or loaded processes", () => {
    expect(selectedReport(null, state, "/p")).toBeNull();
    expect(selectedReport("9.9-z", state, "/p")).toBeNull();
    expect(selectedReport("index", loaded([]), "/p")).toBeNull();
    expect(selectedReport("1.1-a", { kind: "loading" }, "/p")).toBeNull();
  });
});

describe("reconcileProcess", () => {
  const state = loaded(
    [process({ number: "1.1", slug: "a", html: "1.1-a.html", verdict: "go" })],
    "index.html",
  );

  it("keeps a selected process that still exists", () => {
    expect(reconcileProcess("1.1-a", state)).toBe("1.1-a");
    expect(reconcileProcess("index", state)).toBe("index");
  });

  it("clears a process that disappeared", () => {
    expect(reconcileProcess("1.2-b", state)).toBeNull();
    expect(reconcileProcess("index", loaded([]))).toBeNull();
    expect(reconcileProcess(null, state)).toBeNull();
  });

  it("keeps the selection while the list is loading or failing", () => {
    expect(reconcileProcess("1.1-a", { kind: "loading" })).toBe("1.1-a");
    expect(reconcileProcess("1.1-a", { kind: "error", message: "x" })).toBe("1.1-a");
  });
});
