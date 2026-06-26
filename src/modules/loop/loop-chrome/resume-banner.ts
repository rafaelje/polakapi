import {
  listInterruptedRuns,
  loadInterruptedRunDetails,
  type InterruptedRunDetails,
} from "../core/resume-detector";

import { shortRunId } from "./header";
import type { ResumeAction, ResumeProbe } from "./types";

// Single module-scoped handler — there is only one chrome instance per window.
let resumeActionHandler: ((action: ResumeAction) => Promise<void>) | null = null;

export function setResumeActionHandler(
  handler: ((action: ResumeAction) => Promise<void>) | null,
): void {
  resumeActionHandler = handler;
}

// Returns the first resumable run; the backend list comes sorted by heartbeat
// desc, so this is the most recent. If state.json is corrupt we try the next.
export async function probeForInterruptedRun(
  projectPath: string,
): Promise<InterruptedRunDetails | null> {
  try {
    const list = await listInterruptedRuns(projectPath);
    for (const summary of list) {
      const details = await loadInterruptedRunDetails(projectPath, summary);
      if (details) return details;
    }
  } catch (err) {
    console.error("loop chrome: probe for interrupted runs failed", err);
  }
  return null;
}

function renderResumeBanner(details: InterruptedRunDetails): HTMLElement {
  const banner = document.createElement("section");
  banner.className = "loop-resume-banner";
  banner.dataset.runId = details.summary.runId;
  banner.setAttribute("role", "region");
  banner.setAttribute("aria-label", "interrupted run detected");
  banner.setAttribute("aria-live", "polite");

  const icon = document.createElement("span");
  icon.className = "loop-resume-banner-icon";
  icon.textContent = "⏸";
  icon.setAttribute("aria-hidden", "true");

  const body = document.createElement("div");
  body.className = "loop-resume-banner-body";

  const title = document.createElement("p");
  title.className = "loop-resume-banner-title";
  title.textContent = "interrupted run detected · resume?";

  const meta = document.createElement("p");
  meta.className = "loop-resume-banner-meta";
  const ageLabel = describeAge(details.summary.ageMs);
  const stage = details.state.currentStage ? ` · ${details.state.currentStage} in progress` : "";
  const phaseLabel =
    details.state.currentPhaseIndex >= 0 && details.state.phases[details.state.currentPhaseIndex]
      ? ` · phase ${details.state.phases[details.state.currentPhaseIndex].id}`
      : "";
  meta.textContent = `run ${shortRunId(details.summary.runId)}${phaseLabel}${stage} · last heartbeat ${ageLabel}`;

  body.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "loop-resume-banner-actions";

  const resume = document.createElement("button");
  resume.type = "button";
  resume.className = "loop-btn loop-btn-primary";
  resume.textContent = "resume";
  resume.dataset.resumeAction = "resume";
  resume.setAttribute("aria-label", "resume the interrupted run");

  const archive = document.createElement("button");
  archive.type = "button";
  archive.className = "loop-btn loop-btn-ghost";
  archive.textContent = "archive";
  archive.dataset.resumeAction = "archive";
  archive.setAttribute("aria-label", "archive the interrupted run");

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "loop-btn loop-btn-ghost loop-resume-banner-dismiss";
  dismiss.textContent = "×";
  dismiss.title = "hide this banner (does not archive or delete)";
  dismiss.setAttribute("aria-label", "hide resume banner");
  dismiss.dataset.resumeAction = "dismiss";

  // Handlers wired in `reconcileResumeBanner` after insertion to avoid
  // capturing stale MountedStep refs across re-renders.
  actions.append(resume, archive, dismiss);
  banner.append(icon, body, actions);
  return banner;
}

export function reconcileResumeBanner(shell: Element, resumeProbe: ResumeProbe | null): void {
  const existing = shell.querySelector<HTMLElement>(".loop-resume-banner");
  if (!resumeProbe?.pending) {
    if (existing) existing.remove();
    return;
  }
  const details = resumeProbe.pending;
  if (existing && existing.dataset.runId === details.summary.runId) {
    // Reconnect handlers in case the previous render cleared the closure.
    bindResumeBannerHandlers(existing);
    return;
  }
  const banner = renderResumeBanner(details);
  if (existing) existing.replaceWith(banner);
  else {
    const header = shell.querySelector(".loop-header");
    if (header && header.nextSibling) {
      shell.insertBefore(banner, header.nextSibling);
    } else if (header) {
      shell.appendChild(banner);
    } else {
      shell.insertBefore(banner, shell.firstChild);
    }
  }
  bindResumeBannerHandlers(banner);
}

function bindResumeBannerHandlers(banner: HTMLElement): void {
  const buttons = banner.querySelectorAll<HTMLButtonElement>("button[data-resume-action]");
  for (const btn of buttons) {
    const action = btn.dataset.resumeAction as ResumeAction | undefined;
    if (!action) continue;
    btn.onclick = () => {
      if (!resumeActionHandler) return;
      // Disable all buttons while the action runs to prevent double clicks.
      const all = banner.querySelectorAll<HTMLButtonElement>("button");
      for (const b of all) b.disabled = true;
      void resumeActionHandler(action).finally(() => {
        for (const b of all) b.disabled = false;
      });
    };
  }
}

function describeAge(ageMs: number): string {
  if (ageMs < 0) return "moments ago";
  if (ageMs === Number.MAX_SAFE_INTEGER || ageMs > 1_000_000_000_000) return "no heartbeat";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
