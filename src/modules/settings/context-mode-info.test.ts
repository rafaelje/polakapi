import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ContextModePrefs from "./context-mode-preferences";

vi.mock("./context-mode-preferences", async (importOriginal) => {
  const actual = await importOriginal<typeof ContextModePrefs>();
  return {
    ...actual,
    loadContextMode: vi.fn(),
    saveContextMode: vi.fn().mockResolvedValue(undefined),
  };
});

import { mountContextModeSection } from "./context-mode-section";
import { contextModeDefaults, loadContextMode, saveContextMode } from "./context-mode-preferences";

const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"]');
const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  )!;

beforeEach(async () => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div class="settings-group"></div>';
  vi.mocked(loadContextMode).mockResolvedValue({
    ...contextModeDefaults,
    bypassKb: 3,
    externalizeKb: 250,
  });
  await mountContextModeSection({
    group: document.querySelector<HTMLElement>(".settings-group")!,
    onError: vi.fn(),
    onSaved: vi.fn(),
    syncHooks: vi.fn().mockResolvedValue(undefined),
  });
});

describe("how context mode works", () => {
  it("is closed until the button is pressed", () => {
    expect(dialog()).toBeNull();
    button("How it works").click();
    expect(dialog()).not.toBeNull();
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");
  });

  it("names the files it changes", () => {
    button("How it works").click();
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("~/.claude/settings.json");
    expect(text).toContain("~/.cursor/hooks.json");
    expect(text).not.toContain("What it never does");
    expect(text).toContain("Codex and OpenCode: not connected yet");
  });

  it("quotes the thresholds actually in effect", () => {
    button("How it works").click();
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("Output under 3 KB");
    expect(text).toContain("anything over 250 KB");
  });

  it("closes from the button, the close icon, Escape and the backdrop", () => {
    const trigger = button("How it works");

    trigger.click();
    button("Got it").click();
    expect(dialog()).toBeNull();
    // Focus goes back to where the user was.
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();
    expect(dialog()).toBeNull();

    trigger.click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog()).toBeNull();

    trigger.click();
    document.querySelector<HTMLElement>(".ctx-info-backdrop")!.click();
    expect(dialog()).toBeNull();
  });

  it("stays open when clicking inside the dialog", () => {
    button("How it works").click();
    dialog()!.click();
    expect(dialog()).not.toBeNull();
  });

  it("only explains: opening it changes no setting", () => {
    button("How it works").click();
    button("Got it").click();
    expect(saveContextMode).not.toHaveBeenCalled();
  });
});
