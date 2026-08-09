import { afterEach, describe, expect, it } from "vitest";

import { selectModal } from "./modal";

describe("selectModal", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("labels the select with the dialog title", async () => {
    const result = selectModal({
      title: "Move project",
      options: [{ value: "workspace", label: "Workspace" }],
    });
    const title = document.querySelector<HTMLElement>(".modal-title");
    const select = document.querySelector<HTMLSelectElement>("select");

    expect(title?.id).toBeTruthy();
    expect(select?.getAttribute("aria-labelledby")).toBe(title?.id);

    document.querySelector<HTMLButtonElement>(".modal-btn")?.click();
    await expect(result).resolves.toBeNull();
  });
});
