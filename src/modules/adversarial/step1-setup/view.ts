import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { showToast } from "../../../shared/ui/toast";
import { stringifyError } from "../../../shared/errors";
import type { LoopCli } from "../../loop/types";
import { invokers, type BranchDiff, type CliValidation } from "../scheduler/invokers";
import {
  cliSupportsEffort,
  DEFAULT_BLOCKING,
  DEFAULT_ROUNDS,
  DEFAULT_TIMEOUT_SECS,
  MAX_ROUNDS,
  MIN_ROUNDS,
  defaultModelForCli,
  type DebateSettings,
  type DebateSlot,
  type DiffMode,
  type Effort,
  type Severity,
} from "../types";

export interface Step1Config {
  projectPath: string;
  projectName: string;
  runId: string;
  onExecute(settings: DebateSettings, diff: string, diffTruncated: boolean): void;
}

const CLIS: LoopCli[] = ["claude", "codex", "opencode"];
const EFFORTS: Effort[] = ["default", "low", "medium", "high", "xhigh"];
const SEVERITIES: Severity[] = ["critical", "major", "minor", "nit"];

interface State {
  baseRef: string;
  baseAutoDetected: boolean;
  scopeRaw: string;
  diffMode: DiffMode;
  diff: BranchDiff | null;
  diffError: string | null;
  loadingDiff: boolean;
  critic: DebateSlot;
  defender: DebateSlot;
  criticValid: CliValidation | null;
  defenderValid: CliValidation | null;
  rounds: number;
  blockingSeverity: Severity;
  timeoutSecs: number;
}

export function mountStep1Setup(slot: HTMLElement, config: Step1Config): { dispose(): void } {
  const state: State = {
    baseRef: "",
    baseAutoDetected: false,
    scopeRaw: "",
    diffMode: "committed",
    diff: null,
    diffError: null,
    loadingDiff: false,
    critic: { cli: "claude", model: defaultModelForCli("claude"), effort: "default" },
    defender: { cli: "codex", model: defaultModelForCli("codex"), effort: "high" },
    criticValid: null,
    defenderValid: null,
    rounds: DEFAULT_ROUNDS,
    blockingSeverity: DEFAULT_BLOCKING,
    timeoutSecs: DEFAULT_TIMEOUT_SECS,
  };

  slot.replaceChildren();
  const root = document.createElement("div");
  root.className = "adv-content";
  slot.appendChild(root);

  const render = (): void => {
    root.replaceChildren(
      renderProjectCard(config, state),
      renderBaseCard(
        state,
        onBaseChange,
        onScopeChange,
        onModeChange,
        onRefreshDiff,
        () => void onBrowseScope(),
      ),
      renderSlotsCard(state, onSlotChange),
      renderRunSettings(state, onSettingChange),
      renderActions(state, onRun),
    );
  };

  // ─ handlers ─

  const detectAndFetch = async (): Promise<void> => {
    try {
      const detected = await invokers.detectBaseRef(config.projectPath);
      state.baseRef = detected;
      state.baseAutoDetected = true;
      render();
      await fetchDiff();
    } catch (err) {
      state.diffError = String(err);
      render();
    }
  };

  const fetchDiff = async (): Promise<void> => {
    // In `committed` mode we require a base ref; in `working` mode we don't
    // (the working tree diff is defined against HEAD, not a branch).
    if (state.diffMode === "committed" && !state.baseRef.trim()) {
      state.diff = null;
      state.diffError = null;
      render();
      return;
    }
    state.loadingDiff = true;
    state.diffError = null;
    render();
    try {
      const paths = parseScopeInput(state.scopeRaw);
      const diff = await invokers.branchDiff(
        config.projectPath,
        state.baseRef.trim() || "HEAD",
        paths,
        state.diffMode,
      );
      state.diff = diff;
    } catch (err) {
      state.diff = null;
      state.diffError = String(err);
    } finally {
      state.loadingDiff = false;
      render();
    }
  };

  // NOTE: the text-input handlers below intentionally do NOT call render().
  // Re-rendering while the user is typing rebuilds the <input> DOM node and
  // yanks focus away — one keystroke per element. The state stays in sync
  // via the `input` event; the visual refresh happens on blur (via
  // onRefreshDiff / fetchDiff) or on any button click.
  const onBaseChange = (v: string): void => {
    state.baseRef = v;
    state.baseAutoDetected = false;
  };
  const onScopeChange = (v: string): void => {
    state.scopeRaw = v;
  };
  const onModeChange = (v: DiffMode): void => {
    state.diffMode = v;
    state.diff = null;
    state.diffError = null;
    render();
    void fetchDiff();
  };
  const onRefreshDiff = (): void => {
    void fetchDiff();
  };

  const onBrowseScope = async (): Promise<void> => {
    let picked: string | string[] | null;
    try {
      picked = await openDialog({
        directory: true,
        multiple: true,
        defaultPath: config.projectPath,
        title: "Choose folders to include in the review",
      });
    } catch (err) {
      showToast(`could not open folder picker: ${stringifyError(err)}`, "error");
      return;
    }
    if (picked === null) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    const relatives: string[] = [];
    for (const abs of paths) {
      const rel = toRelativePath(config.projectPath, abs);
      if (rel === null) {
        showToast(`path is outside the project: ${abs}`, "error");
        continue;
      }
      if (rel.length === 0) {
        state.scopeRaw = "";
        render();
        void fetchDiff();
        return;
      }
      relatives.push(rel);
    }
    if (relatives.length === 0) return;
    state.scopeRaw = mergeScope(state.scopeRaw, relatives);
    render();
    void fetchDiff();
  };

  const onSlotChange = (role: "critic" | "defender", patch: Partial<DebateSlot>): void => {
    const target = role === "critic" ? state.critic : state.defender;
    const cliChanged = patch.cli !== undefined && patch.cli !== target.cli;
    const next: DebateSlot = { ...target, ...patch };
    if (cliChanged) next.model = defaultModelForCli(next.cli);
    if (role === "critic") state.critic = next;
    else state.defender = next;
    if (cliChanged || patch.model !== undefined) {
      if (role === "critic") state.criticValid = null;
      else state.defenderValid = null;
      void validateSlot(role);
    }
    render();
  };

  const validateSlot = async (role: "critic" | "defender"): Promise<void> => {
    const slot = role === "critic" ? state.critic : state.defender;
    try {
      const v = await invokers.validateCli(slot);
      if (role === "critic") state.criticValid = v;
      else state.defenderValid = v;
    } catch (err) {
      const failed: CliValidation = { ok: false, reason: String(err) };
      if (role === "critic") state.criticValid = failed;
      else state.defenderValid = failed;
    }
    render();
  };

  const onSettingChange = (patch: Partial<State>): void => {
    Object.assign(state, patch);
    render();
  };

  const onRun = (): void => {
    if (!canRun(state)) return;
    if (!state.diff) return;
    const settings: DebateSettings = {
      projectPath: config.projectPath,
      runId: config.runId,
      baseRef: state.diff.baseRef,
      mergeBase: state.diff.mergeBase,
      headSha: state.diff.headSha,
      rounds: state.rounds,
      critic: state.critic,
      defender: state.defender,
      blockingSeverity: state.blockingSeverity,
      timeoutSecs: state.timeoutSecs,
      scopePaths: state.diff.paths,
      diffMode: state.diff.mode,
    };
    config.onExecute(settings, state.diff.diff, state.diff.truncated);
  };

  render();
  void detectAndFetch();
  void validateSlot("critic");
  void validateSlot("defender");

  return { dispose: () => {} };
}

function renderProjectCard(config: Step1Config, _state: State): HTMLElement {
  const card = document.createElement("section");
  card.className = "adv-card";
  const h = document.createElement("h3");
  h.textContent = "Project";
  const path = document.createElement("div");
  path.className = "adv-help";
  path.textContent = `${config.projectName} — ${config.projectPath}`;
  card.append(h, path);
  return card;
}

function renderBaseCard(
  state: State,
  onBaseChange: (v: string) => void,
  onScopeChange: (v: string) => void,
  onModeChange: (v: DiffMode) => void,
  onRefresh: () => void,
  onBrowseScope: () => void,
): HTMLElement {
  const card = document.createElement("section");
  card.className = "adv-card";
  const h = document.createElement("h3");
  h.textContent = "Diff source";

  // Mode selector: committed vs working tree.
  const modeRow = document.createElement("div");
  modeRow.className = "adv-row";
  for (const mode of ["committed", "working"] as const) {
    const label = document.createElement("label");
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.gap = "6px";
    label.style.marginRight = "12px";
    label.style.cursor = "pointer";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "adv-diff-mode";
    radio.value = mode;
    radio.checked = state.diffMode === mode;
    radio.addEventListener("change", () => onModeChange(mode));
    label.append(radio, document.createTextNode(labelFor(mode)));
    modeRow.appendChild(label);
  }

  const row = document.createElement("div");
  row.className = "adv-row";

  const field = document.createElement("div");
  field.className = "adv-field";
  const baseLabel = document.createElement("label");
  baseLabel.textContent =
    state.diffMode === "working" ? "Base ref (informational)" : "Base ref";
  const input = document.createElement("input");
  input.className = "adv-input";
  input.value = state.baseRef;
  input.placeholder = "main / origin/main / …";
  input.disabled = state.diffMode === "working";
  // Disable the webview's smart-text features — refs and paths must be
  // preserved exactly as typed, no auto-capitalization or autocorrect.
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocorrect", "off");
  // input event updates state but does NOT re-render — that would kill focus
  // on every keystroke. Blur triggers the refresh.
  input.addEventListener("input", (e) => onBaseChange((e.target as HTMLInputElement).value));
  input.addEventListener("blur", () => onRefresh());
  field.append(baseLabel, input);

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "adv-btn";
  refreshBtn.textContent = "refresh diff";
  refreshBtn.addEventListener("click", () => onRefresh());
  refreshBtn.disabled =
    state.loadingDiff || (state.diffMode === "committed" && !state.baseRef.trim());

  row.append(field, refreshBtn);

  // Scope input: comma-separated repo-relative paths. Empty = whole diff.
  // Same focus-preservation rule as the base ref input above.
  const scopeField = document.createElement("div");
  scopeField.className = "adv-field";
  const scopeLabel = document.createElement("label");
  scopeLabel.textContent = "Scope (optional): repo-relative paths, comma-separated";

  const scopeInputRow = document.createElement("div");
  scopeInputRow.className = "adv-row";

  const scopeInput = document.createElement("input");
  scopeInput.className = "adv-input";
  scopeInput.style.flex = "1 1 auto";
  scopeInput.value = state.scopeRaw;
  scopeInput.placeholder = "e.g. app/Services/Payment, resources/js/Pages/Entries";
  scopeInput.autocapitalize = "off";
  scopeInput.autocomplete = "off";
  scopeInput.spellcheck = false;
  scopeInput.setAttribute("autocorrect", "off");
  scopeInput.addEventListener("input", (e) => onScopeChange((e.target as HTMLInputElement).value));
  scopeInput.addEventListener("blur", () => onRefresh());

  const browseBtn = document.createElement("button");
  browseBtn.type = "button";
  browseBtn.className = "adv-btn";
  browseBtn.textContent = "📁 browse";
  browseBtn.title = "Pick folders from the project (multi-select)";
  browseBtn.addEventListener("click", () => {
    void onBrowseScope();
  });

  scopeInputRow.append(scopeInput, browseBtn);
  scopeField.append(scopeLabel, scopeInputRow);

  const summary = document.createElement("div");
  summary.className = "adv-diff-summary";
  if (state.loadingDiff) {
    summary.textContent = "loading diff…";
  } else if (state.diffError) {
    summary.className = "adv-error";
    summary.textContent = state.diffError;
  } else if (state.diff) {
    const scopeSuffix =
      state.diff.paths.length > 0 ? ` · scoped to ${state.diff.paths.join(", ")}` : "";
    const modeHint = state.diff.mode === "working" ? "working tree · " : "";
    summary.textContent = modeHint + (state.diff.stat || "diff loaded (no shortstat)") + scopeSuffix;
    if (state.baseAutoDetected && state.diff.mode === "committed") {
      const hint = document.createElement("span");
      hint.className = "adv-help";
      hint.textContent = `  (auto-detected · merge-base ${short(state.diff.mergeBase)})`;
      summary.appendChild(hint);
    }
    if (state.diff.truncated) {
      const warn = document.createElement("div");
      warn.className = "adv-warn";
      warn.textContent = "⚠️ diff was truncated at 150 KB — expect blind spots past the cutoff.";
      summary.appendChild(warn);
    }
  } else {
    summary.textContent = "no diff loaded yet";
  }

  card.append(h, modeRow, row, scopeField, summary);
  return card;
}

function labelFor(mode: DiffMode): string {
  return mode === "committed"
    ? "Committed vs base"
    : "Uncommitted (working tree vs HEAD)";
}

/**
 * Split a comma-separated scope input into trimmed non-empty entries. The
 * Rust side does the real validation — this only prevents obviously-empty
 * entries from being sent as noise.
 */
function parseScopeInput(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Turn an absolute path returned by the folder picker into a repo-relative
 * one anchored at `projectPath`. Both paths are normalized to forward
 * slashes so the result is portable across Windows and Unix.
 *
 * On macOS, `/Users` is a symlink to `/System/Volumes/Data/Users`; Tauri's
 * picker sometimes returns the "real" (Data/Users) form while the stored
 * projectPath is the friendly one, or vice versa. We try both canonical
 * forms before giving up so the picker doesn't silently drop good folders.
 *
 * Returns `""` when `abs` IS the project root, and `null` when it lies
 * outside the project (which the caller reports as a toast).
 */
export function toRelativePath(projectPath: string, abs: string): string | null {
  const projectVariants = macCanonicalVariants(normalize(projectPath));
  const absVariants = macCanonicalVariants(normalize(abs));
  for (const p of projectVariants) {
    for (const a of absVariants) {
      if (a === p) return "";
      if (a.startsWith(p + "/")) return a.slice(p.length + 1);
    }
  }
  return null;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Return the input path plus its macOS canonical equivalent — with or without
 * the `/System/Volumes/Data` prefix that Catalina+ uses for the read-write
 * data volume. No-op on other platforms.
 */
function macCanonicalVariants(path: string): string[] {
  const out: string[] = [path];
  const DATA_PREFIX = "/System/Volumes/Data";
  if (path.startsWith(DATA_PREFIX + "/")) {
    out.push(path.slice(DATA_PREFIX.length));
  } else if (path.startsWith("/Users/") || path.startsWith("/private/")) {
    out.push(DATA_PREFIX + path);
  }
  return out;
}

/**
 * Merge existing scope text with newly picked relative paths, deduping
 * (case-sensitive) and keeping the existing order. Empty existing values
 * are skipped so we don't emit a leading comma.
 */
export function mergeScope(existing: string, added: string[]): string {
  const existingPaths = parseScopeInput(existing);
  const seen = new Set(existingPaths);
  const combined = [...existingPaths];
  for (const p of added) {
    if (!seen.has(p)) {
      seen.add(p);
      combined.push(p);
    }
  }
  return combined.join(", ");
}

function renderSlotsCard(
  state: State,
  onChange: (role: "critic" | "defender", patch: Partial<DebateSlot>) => void,
): HTMLElement {
  const card = document.createElement("section");
  card.className = "adv-card";
  const h = document.createElement("h3");
  h.textContent = "Debaters";

  const grid = document.createElement("div");
  grid.className = "adv-slot-grid";
  grid.append(
    renderSlot("critic", state.critic, state.criticValid, onChange),
    renderSlot("defender", state.defender, state.defenderValid, onChange),
  );

  if (
    state.critic.cli === state.defender.cli &&
    state.critic.model === state.defender.model &&
    state.critic.effort === state.defender.effort
  ) {
    const warn = document.createElement("div");
    warn.className = "adv-warn";
    warn.textContent =
      "⚠️ both debaters resolve to the same CLI+model+effort — refutation quality drops without model diversity.";
    card.append(h, grid, warn);
    return card;
  }
  card.append(h, grid);
  return card;
}

function renderSlot(
  role: "critic" | "defender",
  slot: DebateSlot,
  validation: CliValidation | null,
  onChange: (role: "critic" | "defender", patch: Partial<DebateSlot>) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "adv-card";
  wrap.style.background = "var(--panel-elev)";

  const title = document.createElement("div");
  title.className = "adv-slot-title";
  title.textContent = role;
  wrap.appendChild(title);

  const row = document.createElement("div");
  row.className = "adv-row";

  // CLI select.
  const cliField = document.createElement("div");
  cliField.className = "adv-field";
  const cliLabel = document.createElement("label");
  cliLabel.textContent = "CLI";
  const cliSelect = document.createElement("select");
  cliSelect.className = "adv-select";
  for (const cli of CLIS) {
    const opt = document.createElement("option");
    opt.value = cli;
    opt.textContent = cli;
    if (cli === slot.cli) opt.selected = true;
    cliSelect.appendChild(opt);
  }
  cliSelect.addEventListener("change", () => onChange(role, { cli: cliSelect.value as LoopCli }));
  cliField.append(cliLabel, cliSelect);

  // Model input.
  const modelField = document.createElement("div");
  modelField.className = "adv-field";
  const modelLabel = document.createElement("label");
  modelLabel.textContent = "Model";
  const modelInput = document.createElement("input");
  modelInput.className = "adv-input";
  modelInput.value = slot.model;
  modelInput.addEventListener("change", () => onChange(role, { model: modelInput.value }));
  modelField.append(modelLabel, modelInput);

  // Effort select.
  const effortField = document.createElement("div");
  effortField.className = "adv-field";
  const effortLabel = document.createElement("label");
  effortLabel.textContent = "Effort";
  const effortSelect = document.createElement("select");
  effortSelect.className = "adv-select";
  const supportsEffort = cliSupportsEffort(slot.cli);
  effortSelect.disabled = !supportsEffort;
  for (const eff of EFFORTS) {
    const opt = document.createElement("option");
    opt.value = eff;
    opt.textContent = supportsEffort ? eff : eff === "default" ? "n/a" : eff;
    if (eff === slot.effort) opt.selected = true;
    effortSelect.appendChild(opt);
  }
  effortSelect.addEventListener("change", () =>
    onChange(role, { effort: effortSelect.value as Effort }),
  );
  effortField.append(effortLabel, effortSelect);

  row.append(cliField, modelField, effortField);
  wrap.appendChild(row);

  // Validation feedback.
  const val = document.createElement("div");
  if (validation === null) {
    val.className = "adv-help";
    val.textContent = "checking CLI on PATH…";
  } else if (validation.ok) {
    val.className = "adv-help";
    val.textContent = `✓ ${slot.cli} is available`;
    val.style.color = "var(--success)";
  } else {
    val.className = "adv-error";
    val.textContent = `✗ ${validation.reason ?? "cli invalid"}`;
  }
  wrap.appendChild(val);
  return wrap;
}

function renderRunSettings(state: State, onChange: (patch: Partial<State>) => void): HTMLElement {
  const card = document.createElement("section");
  card.className = "adv-card";
  const h = document.createElement("h3");
  h.textContent = "Run settings";

  const row = document.createElement("div");
  row.className = "adv-row";

  // Rounds.
  const roundsField = document.createElement("div");
  roundsField.className = "adv-field";
  const roundsLabel = document.createElement("label");
  roundsLabel.textContent = `Rounds (${MIN_ROUNDS}–${MAX_ROUNDS})`;
  const roundsInput = document.createElement("input");
  roundsInput.className = "adv-input";
  roundsInput.type = "number";
  roundsInput.min = String(MIN_ROUNDS);
  roundsInput.max = String(MAX_ROUNDS);
  roundsInput.value = String(state.rounds);
  roundsInput.addEventListener("change", () => {
    const n = Math.max(
      MIN_ROUNDS,
      Math.min(MAX_ROUNDS, Number(roundsInput.value) || DEFAULT_ROUNDS),
    );
    onChange({ rounds: n });
  });
  roundsField.append(roundsLabel, roundsInput);

  // Blocking severity.
  const sevField = document.createElement("div");
  sevField.className = "adv-field";
  const sevLabel = document.createElement("label");
  sevLabel.textContent = "Blocking severity";
  const sevSelect = document.createElement("select");
  sevSelect.className = "adv-select";
  for (const s of SEVERITIES) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    if (s === state.blockingSeverity) opt.selected = true;
    sevSelect.appendChild(opt);
  }
  sevSelect.addEventListener("change", () =>
    onChange({ blockingSeverity: sevSelect.value as Severity }),
  );
  sevField.append(sevLabel, sevSelect);

  // Timeout.
  const timeoutField = document.createElement("div");
  timeoutField.className = "adv-field";
  const timeoutLabel = document.createElement("label");
  timeoutLabel.textContent = "Timeout per pass (sec)";
  const timeoutInput = document.createElement("input");
  timeoutInput.className = "adv-input";
  timeoutInput.type = "number";
  timeoutInput.min = "60";
  timeoutInput.step = "30";
  timeoutInput.value = String(state.timeoutSecs);
  timeoutInput.addEventListener("change", () =>
    onChange({ timeoutSecs: Math.max(60, Number(timeoutInput.value) || DEFAULT_TIMEOUT_SECS) }),
  );
  timeoutField.append(timeoutLabel, timeoutInput);

  row.append(roundsField, sevField, timeoutField);
  card.append(h, row);
  return card;
}

function renderActions(state: State, onRun: () => void): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "adv-actions";
  const run = document.createElement("button");
  run.type = "button";
  run.className = "adv-btn primary";
  run.textContent = "▶ start debate";
  run.disabled = !canRun(state);
  run.addEventListener("click", onRun);
  actions.appendChild(run);
  return actions;
}

function canRun(state: State): boolean {
  if (!state.diff) return false;
  if (state.loadingDiff) return false;
  if (!state.criticValid?.ok) return false;
  if (!state.defenderValid?.ok) return false;
  return true;
}

function short(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) : sha;
}
