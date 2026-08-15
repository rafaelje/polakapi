import type { LoopCli } from "../../loop/types";
import { normalizePath, pathStartsWith, pathsEqual } from "../../path-comparison";
import type { CliValidation } from "../scheduler/invokers";
import {
  cliSupportsEffort,
  DEFAULT_ROUNDS,
  DEFAULT_TIMEOUT_SECS,
  MAX_ROUNDS,
  MIN_ROUNDS,
  type DebateSlot,
  type DiffMode,
  type Effort,
  type Severity,
} from "../types";
import type { SetupState, Step1Config } from "./view";

const CLIS: LoopCli[] = ["claude", "codex", "opencode"];
const EFFORTS: Effort[] = ["default", "low", "medium", "high", "xhigh"];
const SEVERITIES: Severity[] = ["critical", "major", "minor", "nit"];

export function renderProjectCard(config: Step1Config, _state: SetupState): HTMLElement {
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

export function renderBaseCard(
  state: SetupState,
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
  baseLabel.textContent = state.diffMode === "working" ? "Base ref (informational)" : "Base ref";
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
    summary.textContent =
      modeHint + (state.diff.stat || "diff loaded (no shortstat)") + scopeSuffix;
    if (state.baseAutoDetected && state.diff.mode === "committed") {
      const hint = document.createElement("span");
      hint.className = "adv-help";
      hint.textContent = `  (auto-detected · merge-base ${short(state.diff.mergeBase)})`;
      summary.appendChild(hint);
    }
    const excluded = state.diff.filesExcluded;
    const partial = state.diff.filesTruncated;
    if (excluded.length > 0) {
      const info = document.createElement("div");
      info.className = "adv-help";
      info.textContent = `ℹ️ auto-excluded ${excluded.length} generated file${excluded.length === 1 ? "" : "s"} (${describeSample(excluded)}). Add the path to the scope input above to include it anyway.`;
      summary.appendChild(info);
    }
    if (state.diff.truncated) {
      const warn = document.createElement("div");
      warn.className = "adv-warn";
      const bits: string[] = [];
      if (partial.length > 0) {
        bits.push(
          `${partial.length} file${partial.length === 1 ? "" : "s"} trimmed at 40 KB (${describeSample(partial)})`,
        );
      }
      // If truncated=true but no per-file entries, the total cap kicked in.
      if (partial.length === 0 || state.diff.diff.includes("diff truncated at")) {
        bits.push("total diff capped at 400 KB");
      }
      warn.textContent = `⚠️ ${bits.join(" · ")} — expect blind spots past the cutoff.`;
      summary.appendChild(warn);
    }
  } else {
    summary.textContent = "no diff loaded yet";
  }

  card.append(h, modeRow, row, scopeField, summary);
  return card;
}

function labelFor(mode: DiffMode): string {
  return mode === "committed" ? "Committed vs base" : "Uncommitted (working tree vs HEAD)";
}

/**
 * Split a comma-separated scope input into trimmed non-empty entries. The
 * Rust side does the real validation — this only prevents obviously-empty
 * entries from being sent as noise.
 */
export function parseScopeInput(raw: string): string[] {
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
  const projectVariants = macCanonicalVariants(normalizePath(projectPath));
  const absVariants = macCanonicalVariants(normalizePath(abs));
  for (const p of projectVariants) {
    for (const a of absVariants) {
      if (pathsEqual(a, p)) return "";
      if (pathStartsWith(a, p)) return a.slice(p.length + 1);
    }
  }
  return null;
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

export function renderSlotsCard(
  state: SetupState,
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

export function renderRunSettings(
  state: SetupState,
  onChange: (patch: Partial<SetupState>) => void,
): HTMLElement {
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

export function renderActions(state: SetupState, onRun: () => void): HTMLElement {
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

export function canRun(state: SetupState): boolean {
  if (!state.diff) return false;
  if (state.loadingDiff) return false;
  if (!state.criticValid?.ok) return false;
  if (!state.defenderValid?.ok) return false;
  return true;
}

function short(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) : sha;
}

function describeSample(files: string[], max = 3): string {
  if (files.length <= max) return files.join(", ");
  const head = files.slice(0, max).join(", ");
  return `${head}, +${files.length - max} more`;
}
