import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { showToast } from "../../../shared/ui/toast";
import { stringifyError } from "../../../shared/errors";
import { invokers, type BranchDiff, type CliValidation } from "../scheduler/invokers";
import {
  DEFAULT_BLOCKING,
  DEFAULT_ROUNDS,
  DEFAULT_TIMEOUT_SECS,
  defaultModelForCli,
  type DebateSettings,
  type DebateSlot,
  type DiffMeta,
  type DiffMode,
  type Severity,
} from "../types";
import {
  canRun,
  mergeScope,
  parseScopeInput,
  renderActions,
  renderBaseCard,
  renderProjectCard,
  renderRunSettings,
  renderSlotsCard,
  toRelativePath,
} from "./view-sections";

export interface Step1Config {
  projectPath: string;
  projectName: string;
  runId: string;
  onExecute(settings: DebateSettings, diff: string, meta: DiffMeta): void;
}

export interface SetupState {
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
  const state: SetupState = {
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

  const onSettingChange = (patch: Partial<SetupState>): void => {
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
    config.onExecute(settings, state.diff.diff, {
      truncated: state.diff.truncated,
      filesExcluded: state.diff.filesExcluded,
      filesTruncated: state.diff.filesTruncated,
    });
  };

  render();
  void detectAndFetch();
  void validateSlot("critic");
  void validateSlot("defender");

  return { dispose: () => {} };
}
