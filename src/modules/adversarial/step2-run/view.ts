// Step 2 UI: live timeline of critic ↔ defender passes, findings counters,
// abort button.

import type { DebateScheduler } from "../scheduler/debate-scheduler";
import type { DebateState, PassRecord } from "../types";

export interface Step2Config {
  scheduler: DebateScheduler;
  onDone(state: DebateState): void;
  onAbort(): void;
}

export function mountStep2Run(slot: HTMLElement, config: Step2Config): { dispose(): void } {
  slot.replaceChildren();
  const root = document.createElement("div");
  root.className = "adv-content";
  slot.appendChild(root);

  const render = (state: DebateState): void => {
    root.replaceChildren(
      renderTotalsCard(state, () => config.onAbort()),
      renderTimeline(state),
      renderCounters(state),
    );
    if (state.status === "completed" || state.status === "aborted" || state.status === "error") {
      // Debounce to next tick so the last render lands before switching steps.
      setTimeout(() => config.onDone(state), 50);
    }
  };

  const unsubscribe = config.scheduler.subscribe(render);
  return {
    dispose: () => {
      unsubscribe();
    },
  };
}

function renderTotalsCard(state: DebateState, onAbort: () => void): HTMLElement {
  const card = document.createElement("section");
  card.className = "adv-card";
  const row = document.createElement("div");
  row.className = "adv-row";
  const info = document.createElement("div");
  info.className = "adv-help";
  info.textContent = `status: ${state.status}  ·  tokens ${state.totals.tokensIn}/${state.totals.tokensOut}  ·  $${state.totals.costUsd.toFixed(4)}`;
  row.appendChild(info);
  if (state.status === "running") {
    const abort = document.createElement("button");
    abort.type = "button";
    abort.className = "adv-btn danger";
    abort.textContent = "abort";
    abort.addEventListener("click", () => onAbort());
    row.appendChild(abort);
  }
  card.appendChild(row);
  return card;
}

function renderTimeline(state: DebateState): HTMLElement {
  const card = document.createElement("section");
  card.className = "adv-card";
  const h = document.createElement("h3");
  h.textContent = "Timeline";
  card.appendChild(h);
  const list = document.createElement("div");
  list.className = "adv-timeline";
  for (const pass of state.passes) {
    list.appendChild(renderPass(pass));
  }
  card.appendChild(list);
  return card;
}

function renderPass(pass: PassRecord): HTMLElement {
  const row = document.createElement("div");
  row.className = `adv-timeline-row ${pass.status}`;
  const label = document.createElement("div");
  label.className = "adv-timeline-label";
  label.textContent = `R${pass.round} · ${pass.role}`;
  const status = document.createElement("div");
  status.className = "adv-timeline-status";
  status.textContent = pass.message ? `${pass.status} — ${pass.message}` : pass.status;
  const meta = document.createElement("div");
  meta.className = "adv-timeline-meta";
  const elapsed = pass.startedAt && pass.endedAt ? `${pass.endedAt - pass.startedAt} ms` : "";
  meta.textContent =
    `${pass.tokensIn}/${pass.tokensOut} tokens · $${pass.costUsd.toFixed(4)}${elapsed ? ` · ${elapsed}` : ""}` +
    (pass.retries ? ` · retries: ${pass.retries}` : "");
  row.append(label, status, meta);
  return row;
}

function renderCounters(state: DebateState): HTMLElement {
  const card = document.createElement("section");
  card.className = "adv-card";
  const h = document.createElement("h3");
  h.textContent = "Findings";
  const counters = document.createElement("div");
  counters.className = "adv-counters";
  const counts = { open: 0, confirmed: 0, challenged: 0, contested: 0, disputed: 0, withdrawn: 0 };
  for (const f of state.findings.findings) counts[f.status] += 1;
  for (const [key, value] of Object.entries(counts)) {
    const c = document.createElement("span");
    c.className = "adv-counter";
    c.innerHTML = `${key}: <strong>${value}</strong>`;
    counters.appendChild(c);
  }
  card.append(h, counters);
  return card;
}
