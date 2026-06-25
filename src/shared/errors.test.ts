import { describe, expect, it } from "vitest";

import { stringifyError } from "./errors";

describe("stringifyError", () => {
  it("returns Error.message for Error instances", () => {
    expect(stringifyError(new Error("boom"))).toBe("boom");
    expect(stringifyError(new TypeError("bad type"))).toBe("bad type");
  });

  it("passes plain strings through", () => {
    expect(stringifyError("just a string")).toBe("just a string");
    expect(stringifyError("")).toBe("");
  });

  it("JSON-stringifies plain objects", () => {
    expect(stringifyError({ code: 42, msg: "oops" })).toBe('{"code":42,"msg":"oops"}');
  });

  it("JSON-stringifies primitives", () => {
    expect(stringifyError(42)).toBe("42");
    expect(stringifyError(null)).toBe("null");
    expect(stringifyError(true)).toBe("true");
  });

  it("falls back to String(err) for cyclic objects (JSON.stringify would throw)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // String(cyclic) → "[object Object]" — what matters is that it doesn't throw.
    expect(() => stringifyError(cyclic)).not.toThrow();
    expect(stringifyError(cyclic)).toBe("[object Object]");
  });
});
