import { afterEach, describe, expect, it } from "vitest";

import { confirmDeleteProjects } from "./confirm-delete";

describe("confirmDeleteProjects", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("uses singular and plural project titles", async () => {
    const singular = confirmDeleteProjects(1, 0);
    expect(document.querySelector(".modal-title")?.textContent).toBe("Delete 1 project?");
    document.querySelector<HTMLButtonElement>(".modal-btn-danger")?.click();
    await singular;

    const plural = confirmDeleteProjects(2, 0);
    expect(document.querySelector(".modal-title")?.textContent).toBe("Delete 2 projects?");
    document.querySelector<HTMLButtonElement>(".modal-btn-danger")?.click();
    await plural;
  });
});
