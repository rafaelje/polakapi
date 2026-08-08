import { afterEach, describe, expect, it, vi } from "vitest";

import { openProjectCommandCenter, type ProjectCommand } from "./project-command-center";

function trigger(): HTMLButtonElement {
  const button = document.createElement("button");
  button.setAttribute("aria-expanded", "false");
  document.body.append(button);
  return button;
}

function commands(run = vi.fn()): ProjectCommand[] {
  return [
    { id: "disabled", label: "Unavailable command", group: "Workspace", disabled: true, run },
    { id: "layouts", label: "Layouts", group: "Workspace", run },
    {
      id: "terminal",
      label: "Open in terminal",
      group: "Open project",
      keywords: ["shell"],
      run,
    },
  ];
}

describe("project command center", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("filters commands by labels, groups, and keywords", () => {
    openProjectCommandCenter({ trigger: trigger(), commands: commands() });
    const input = document.querySelector<HTMLInputElement>(".project-command-center-input");

    if (input) input.value = "shell";
    input?.dispatchEvent(new Event("input", { bubbles: true }));

    const options = [...document.querySelectorAll<HTMLElement>("[role=option]")];
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain("Open in terminal");
  });

  it("executes the selected enabled command with Enter", () => {
    const run = vi.fn();
    openProjectCommandCenter({ trigger: trigger(), commands: commands(run) });
    const input = document.querySelector<HTMLInputElement>(".project-command-center-input");

    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(run).toHaveBeenCalledOnce();
    expect(document.querySelector(".project-command-center")).toBeNull();
  });

  it("shows an empty result and does not execute on Enter", () => {
    const run = vi.fn();
    openProjectCommandCenter({ trigger: trigger(), commands: commands(run) });
    const input = document.querySelector<HTMLInputElement>(".project-command-center-input");

    if (input) input.value = "missing";
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(document.querySelector(".project-command-center-empty")?.textContent).toBe(
      "No matching commands",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("closes with Escape and returns focus", () => {
    const button = trigger();
    openProjectCommandCenter({ trigger: button, commands: commands() });

    document
      .querySelector<HTMLInputElement>(".project-command-center-input")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(document.querySelector(".project-command-center")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });
});
