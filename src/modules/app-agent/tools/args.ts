import { ToolError, type ToolArgs } from "./types";

// Argument readers that turn a malformed call into a readable ToolError.

export function optionalString(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolError(`"${key}" must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function requiredString(args: ToolArgs, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined) throw new ToolError(`"${key}" is required`);
  return value;
}

export function optionalInteger(
  args: ToolArgs,
  key: string,
  bounds?: { min?: number; max?: number },
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolError(`"${key}" must be an integer`);
  }
  if (bounds?.min !== undefined && value < bounds.min) {
    throw new ToolError(`"${key}" must be at least ${bounds.min}`);
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    throw new ToolError(`"${key}" must be at most ${bounds.max}`);
  }
  return value;
}

export function optionalBoolean(args: ToolArgs, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ToolError(`"${key}" must be a boolean`);
  return value;
}

export function optionalStringArray(args: ToolArgs, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolError(`"${key}" must be an array of strings`);
  }
  return value as string[];
}

export function requiredStringArray(args: ToolArgs, key: string): string[] {
  const value = optionalStringArray(args, key);
  if (!value) throw new ToolError(`"${key}" is required`);
  return value;
}

export function oneOf<T extends string>(
  args: ToolArgs,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(args, key);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ToolError(`"${key}" must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}
