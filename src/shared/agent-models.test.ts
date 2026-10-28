import { describe, expect, it } from "vitest";
import { modelChoices } from "./agent-models";

const models = [
  { id: "fable", label: "fable" },
  { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
];

describe("modelChoices", () => {
  it("starts with the default and lists the CLI's models", () => {
    expect(modelChoices(models, "", "CLI default")).toEqual([
      { value: "", label: "CLI default" },
      { value: "fable", label: "fable" },
      { value: "gpt-6.1-sol", label: "GPT-6.1-Sol (gpt-6.1-sol)" },
    ]);
  });

  it("keeps a current model the CLI no longer lists", () => {
    const choices = modelChoices(models, "old-model", "CLI default");

    expect(choices[choices.length - 1]).toEqual({ value: "old-model", label: "old-model" });
  });

  it("does not repeat a current model the CLI lists", () => {
    expect(modelChoices(models, "fable", "CLI default")).toHaveLength(3);
  });

  it("offers only the default and the current model when the CLI lists none", () => {
    expect(modelChoices([], "x", "Same as the agent")).toEqual([
      { value: "", label: "Same as the agent" },
      { value: "x", label: "x" },
    ]);
  });
});
