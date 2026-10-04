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
import {
  contextModeDefaults,
  loadContextMode,
  saveContextMode,
  type ContextModePreferences,
} from "./context-mode-preferences";

const control = <T extends HTMLElement>(label: string): T =>
  document.querySelector<T>(`[aria-label="${label}"]`)!;

async function mount(patch: Partial<ContextModePreferences> = {}): Promise<HTMLDivElement> {
  document.body.innerHTML = '<div class="settings-group"></div>';
  const group = document.querySelector<HTMLDivElement>(".settings-group")!;
  vi.mocked(loadContextMode).mockResolvedValue({ ...contextModeDefaults, ...patch });
  await mountContextModeSection({ group, onError, onSaved: vi.fn(), syncHooks });
  return group;
}

const syncHooks = vi.fn().mockResolvedValue(undefined);
const onError = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  syncHooks.mockResolvedValue(undefined);
});

describe("context mode section", () => {
  it("offers a toggle for every agent CLI", async () => {
    await mount();
    for (const label of ["Claude Code", "Codex", "OpenCode", "Cursor"]) {
      expect(control<HTMLInputElement>(label)).not.toBeNull();
    }
  });

  it("reflects the stored per-CLI flags", async () => {
    await mount({ clis: { claude: false, codex: true, opencode: true, cursor: false } });
    expect(control<HTMLInputElement>("Claude Code").checked).toBe(false);
    expect(control<HTMLInputElement>("OpenCode").checked).toBe(true);
  });

  it("saves one CLI without disturbing the others", async () => {
    await mount({ enabled: true });
    const opencode = control<HTMLInputElement>("OpenCode");
    opencode.checked = true;
    opencode.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(saveContextMode).toHaveBeenCalledWith(
        expect.objectContaining({
          clis: { ...contextModeDefaults.clis, opencode: true },
        }),
      ),
    );
  });

  it("disables every other control until context mode is on", async () => {
    await mount({ enabled: false });
    expect(control<HTMLInputElement>("Claude Code").disabled).toBe(true);
    expect(control<HTMLSelectElement>("Persistence").disabled).toBe(true);
    expect(control<HTMLInputElement>("Skip output under").disabled).toBe(true);
    // The master switch itself stays usable, or there would be no way back.
    expect(control<HTMLInputElement>("Context mode").disabled).toBe(false);
  });

  it("enables the controls as soon as the master switch is turned on", async () => {
    await mount({ enabled: false });
    const master = control<HTMLInputElement>("Context mode");
    master.checked = true;
    master.dispatchEvent(new Event("change"));
    expect(control<HTMLInputElement>("Claude Code").disabled).toBe(false);
    expect(control<HTMLSelectElement>("Persistence").disabled).toBe(false);
  });

  it("saves the persistence choice", async () => {
    await mount({ enabled: true });
    const storage = control<HTMLSelectElement>("Persistence");
    storage.value = "ephemeral";
    storage.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(saveContextMode).toHaveBeenCalledWith(
        expect.objectContaining({ storage: "ephemeral" }),
      ),
    );
  });

  it("only offers a promotion threshold while sessions are promoted", async () => {
    await mount({ enabled: true, storage: "promote" });
    expect(control<HTMLInputElement>("Persist after").disabled).toBe(false);

    const storage = control<HTMLSelectElement>("Persistence");
    storage.value = "project";
    storage.dispatchEvent(new Event("change"));
    expect(control<HTMLInputElement>("Persist after").disabled).toBe(true);
  });

  it("syncs the agent hooks after every successful save", async () => {
    await mount({ enabled: false });
    const master = control<HTMLInputElement>("Context mode");
    master.checked = true;
    master.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(syncHooks).toHaveBeenCalledOnce());
    // The save has to land first: the sync reads the saved file.
    expect(vi.mocked(saveContextMode).mock.invocationCallOrder[0]).toBeLessThan(
      syncHooks.mock.invocationCallOrder[0],
    );
  });

  it("does not sync hooks when the save itself failed", async () => {
    await mount({ enabled: false });
    vi.mocked(saveContextMode).mockRejectedValueOnce(new Error("disk full"));
    const master = control<HTMLInputElement>("Context mode");
    master.checked = true;
    master.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(syncHooks).not.toHaveBeenCalled();
  });

  it("reports a hook sync failure without hiding that the settings were saved", async () => {
    await mount({ enabled: false });
    syncHooks.mockRejectedValueOnce("could not parse settings.json");
    const master = control<HTMLInputElement>("Context mode");
    master.checked = true;
    master.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("Settings saved, but")),
    );
  });

  it("clamps a threshold typed out of range", async () => {
    await mount({ enabled: true });
    const bypass = control<HTMLInputElement>("Skip output under");
    bypass.value = "99999";
    bypass.dispatchEvent(new Event("change"));
    expect(bypass.value).toBe("1024");
    await vi.waitFor(() =>
      expect(saveContextMode).toHaveBeenCalledWith(expect.objectContaining({ bypassKb: 1024 })),
    );
  });
});
