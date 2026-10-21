import { describe, expect, it } from "vitest";

import {
  oneOf,
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalStringArray,
  requiredString,
} from "./args";
import { ToolError } from "./types";

describe("tool argument readers", () => {
  it("trim strings and treat blanks as missing", () => {
    expect(optionalString({ a: "  x " }, "a")).toBe("x");
    expect(optionalString({ a: "   " }, "a")).toBeUndefined();
    expect(optionalString({}, "a")).toBeUndefined();
    expect(() => optionalString({ a: 3 }, "a")).toThrow(ToolError);
    expect(() => requiredString({}, "a")).toThrow(/required/);
  });

  it("validate integers against bounds", () => {
    expect(optionalInteger({ n: 3 }, "n", { min: 1, max: 3 })).toBe(3);
    expect(() => optionalInteger({ n: 4 }, "n", { max: 3 })).toThrow(/at most 3/);
    expect(() => optionalInteger({ n: 0 }, "n", { min: 1 })).toThrow(/at least 1/);
    expect(() => optionalInteger({ n: 1.5 }, "n")).toThrow(/integer/);
    expect(() => optionalInteger({ n: "1" }, "n")).toThrow(/integer/);
  });

  it("validate booleans, string arrays and enums", () => {
    expect(optionalBoolean({ b: true }, "b")).toBe(true);
    expect(() => optionalBoolean({ b: "yes" }, "b")).toThrow(/boolean/);
    expect(optionalStringArray({ s: ["a", "b"] }, "s")).toEqual(["a", "b"]);
    expect(() => optionalStringArray({ s: ["a", 1] }, "s")).toThrow(/array of strings/);
    expect(oneOf({ m: "working" }, "m", ["committed", "working"] as const)).toBe("working");
    expect(() => oneOf({ m: "other" }, "m", ["committed", "working"] as const)).toThrow(
      /one of: committed, working/,
    );
  });
});
