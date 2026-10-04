import {
  CONTEXT_MODE_CLIS,
  loadContextMode,
  saveContextMode,
  type ContextModePreferences,
} from "./context-mode-preferences";
import { openContextModeInfo } from "./context-mode-info";
import { settingsNumber, settingsRow, settingsSelect, settingsToggle } from "./controls";

// The "Context Mode" settings section. Owns nothing but the configuration:
// which agent CLIs route their tool output into a local store, and whether that
// store survives the session. See docs/context-mode-plan.md.

export interface ContextModeSectionOptions {
  group: HTMLElement;
  /** Surfaces a persistence failure in the shared status line. */
  onError: (message: string) => void;
  /** Clears the status line after a successful write. */
  onSaved: () => void;
  /** Installs or removes the agent hooks so they match what was just saved. */
  syncHooks: () => Promise<unknown>;
}

const STORAGE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["ephemeral", "Do not persist — discard when the session ends"],
  ["promote", "Persist long sessions in the project"],
  ["project", "Always persist in the project"],
];

export async function mountContextModeSection(opts: ContextModeSectionOptions): Promise<void> {
  const { group, onError, onSaved, syncHooks } = opts;
  let preferences = await loadContextMode();
  let saving = Promise.resolve();

  function save(patch: Partial<ContextModePreferences>): void {
    preferences = { ...preferences, ...patch };
    const snapshot = { ...preferences };
    // Hooks are synced only after the file is written: the sync reads the saved
    // settings, so running it earlier would install yesterday's choice.
    saving = saving.catch(() => {}).then(() => saveContextMode(snapshot));
    void saving.then(
      () =>
        syncHooks().then(onSaved, (error: unknown) =>
          onError(`Settings saved, but the agent hooks could not be updated: ${String(error)}`),
        ),
      () => onError("Could not save context mode settings. Try changing the setting again."),
    );
    refresh();
  }

  const explain = document.createElement("button");
  explain.type = "button";
  explain.textContent = "How it works";
  explain.addEventListener("click", () => {
    void openContextModeInfo(preferences, explain);
  });
  settingsRow(
    group,
    "Context mode",
    "Divert large tool results into a local store and give the model a searchable pointer instead, so its context stays free for the work.",
  ).append(
    explain,
    settingsToggle("Context mode", preferences.enabled, (enabled) => save({ enabled })),
  );

  const cliToggles: HTMLInputElement[] = [];
  for (const cli of CONTEXT_MODE_CLIS) {
    const toggle = settingsToggle(cli.label, preferences.clis[cli.id], (checked) =>
      save({ clis: { ...preferences.clis, [cli.id]: checked } }),
    );
    cliToggles.push(toggle);
    settingsRow(group, cli.label, cli.enforcement).append(toggle);
  }

  const storage = settingsSelect("Persistence", STORAGE_OPTIONS, preferences.storage, (value) =>
    save({ storage: value as ContextModePreferences["storage"] }),
  );
  settingsRow(
    group,
    "Persistence",
    "Persisted sessions live in .polakapi/ inside the project. That folder ignores itself, so your .gitignore is left untouched.",
  ).append(storage);

  const promoteAfter = settingsNumber(
    "Persist after",
    preferences.promoteAfterSources,
    { min: 1, max: 10_000 },
    (promoteAfterSources) => save({ promoteAfterSources }),
  );
  settingsRow(
    group,
    "Persist after",
    "How many offloaded results a session may hold in the temp folder before it moves into the project.",
  ).append(promoteAfter);

  const bypass = settingsNumber(
    "Skip output under",
    preferences.bypassKb,
    { min: 0, max: 1024 },
    (bypassKb) => save({ bypassKb }),
  );
  settingsRow(
    group,
    "Skip output under (KB)",
    "Small results are left alone. Below about a kilobyte the offloading machinery costs more context than it saves.",
  ).append(bypass);

  const externalize = settingsNumber(
    "Externalize output over",
    preferences.externalizeKb,
    { min: 1, max: 100_000 },
    (externalizeKb) => save({ externalizeKb }),
  );
  settingsRow(
    group,
    "Externalize output over (KB)",
    "Results this large are indexed and replaced by a pointer the model can query, instead of being summarised.",
  ).append(externalize);

  function refresh(): void {
    const on = preferences.enabled;
    for (const toggle of cliToggles) toggle.disabled = !on;
    storage.disabled = !on;
    bypass.disabled = !on;
    externalize.disabled = !on;
    // Only the promote mode has anything to promote after.
    promoteAfter.disabled = !on || preferences.storage !== "promote";
  }

  refresh();
}
