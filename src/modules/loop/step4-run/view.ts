import {
  ALL_AGENT_ROLES,
  SEQUENTIAL_AGENTS,
  type AgentStageState,
  type ConflictDecision,
  type IntegratorState,
  type PhaseState,
  type RunSchedulerState,
  type SequentialAgent,
} from "../core/run-scheduler";
import type { ListenerBag } from "../shared/listener-bag";
import { confirmModal } from "../../../shared/ui/modal";

import {
  agentShortLabel,
  describeRunStatus,
  formatNumber,
  gridCell,
  integratorIcon,
  integratorStatusLabel,
  roleLabel,
  stageProgressPct,
  statusLabel,
} from "./helpers";
import type { Step3RunContext } from "./state";

type On = ListenerBag["on"];

export function renderView(
  slot: HTMLElement,
  state: RunSchedulerState,
  ctx: Step3RunContext,
  on: On,
): void {
  const children: HTMLElement[] = [renderHeader(state, ctx, on)];
  const banner = renderWarningBanner(state);
  if (banner) children.push(banner);
  children.push(
    state.mode === "hybrid" ? renderHybridTimeline(state, ctx, on) : renderTimeline(state),
  );
  children.push(renderBudgetPanel(state));
  slot.replaceChildren(...children);
}

function renderWarningBanner(state: RunSchedulerState): HTMLElement | null {
  const exhausted = state.phases.filter((p) => p.reviewerExhausted);
  if (exhausted.length === 0) return null;
  const banner = document.createElement("div");
  banner.className = "loop-step3-run-banner loop-step3-run-banner-warning";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  const icon = document.createElement("span");
  icon.className = "loop-step3-run-banner-icon";
  icon.textContent = "!";
  icon.setAttribute("aria-hidden", "true");
  const msg = document.createElement("span");
  msg.textContent =
    exhausted.length === 1
      ? `1 phase hit the reviewer cap (${exhausted[0].name}) — debt noted in knowledge`
      : `${exhausted.length} phases hit the reviewer cap — debts noted in their knowledge.md`;
  banner.append(icon, msg);
  return banner;
}

function renderHeader(state: RunSchedulerState, ctx: Step3RunContext, on: On): HTMLElement {
  const header = document.createElement("div");
  header.className = "loop-step3-run-header";

  const left = document.createElement("div");
  left.className = "loop-step3-run-header-left";
  const title = document.createElement("div");
  title.className = "loop-step3-run-title";
  title.textContent = `Step 3 · running · ${ctx.projectName}`;
  const sub = document.createElement("div");
  sub.className = "loop-step3-run-subtitle";
  sub.textContent = describeRunStatus(state);
  left.append(title, sub);

  const right = document.createElement("div");
  right.className = "loop-step3-run-header-right";

  // If pause was due to integrator conflict, disable pause/resume — resuming
  // here would launch a second cycle in parallel with `awaitConflictDecision`.
  const conflictActive = state.integrators.some((i) => i.status === "conflict");
  const pause = document.createElement("button");
  pause.type = "button";
  pause.className = "loop-btn loop-btn-ghost";
  pause.textContent = state.status === "paused" ? "resume" : "pause run";
  pause.setAttribute(
    "aria-label",
    state.status === "paused" ? "resume the paused run" : "pause the run in progress",
  );
  pause.disabled = state.status === "completed" || state.status === "aborted" || conflictActive;
  on(pause, "click", () => {
    if (state.status === "paused") {
      void ctx.scheduler.start();
    } else if (state.status === "running") {
      ctx.scheduler.pause();
    }
  });

  const abort = document.createElement("button");
  abort.type = "button";
  abort.className = "loop-btn loop-btn-ghost loop-step3-run-abort";
  abort.textContent = "abort run";
  abort.setAttribute("aria-label", "abort the run in progress");
  abort.disabled =
    state.status === "completed" || state.status === "aborted" || state.status === "idle";
  on(abort, "click", () => {
    void (async () => {
      const ok = await confirmModal({
        title: "Abort the run?",
        message: "Generated outputs stay on disk for auditing, but the cycle stops.",
        confirmLabel: "abort",
        cancelLabel: "cancel",
        danger: true,
      });
      if (ok) ctx.scheduler.abort();
    })();
  });

  right.append(pause, abort);
  header.append(left, right);
  return header;
}

function renderTimeline(state: RunSchedulerState): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "loop-step3-run-timeline";

  if (state.phases.length === 0) {
    const empty = document.createElement("p");
    empty.className = "loop-step3-run-empty";
    empty.textContent = "No phases to run — go back to Step 2 to decompose the problem.";
    wrap.appendChild(empty);
    return wrap;
  }

  const headerRow = document.createElement("div");
  headerRow.className = "loop-step3-run-grid loop-step3-run-grid-head";
  headerRow.append(
    gridCell("phase", "head"),
    gridCell("analysis", "head"),
    gridCell("implementation", "head"),
    gridCell("reviewer", "head"),
    gridCell("knowledge", "head"),
  );
  wrap.appendChild(headerRow);

  for (let i = 0; i < state.phases.length; i++) {
    wrap.appendChild(renderPhaseRow(state.phases[i], i, state));
  }
  return wrap;
}

function renderHybridTimeline(state: RunSchedulerState, ctx: Step3RunContext, on: On): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "loop-step3-run-timeline loop-step3-run-hybrid";

  if (state.phases.length === 0) {
    const empty = document.createElement("p");
    empty.className = "loop-step3-run-empty";
    empty.textContent = "No phases to run — go back to Step 2 to decompose the problem.";
    wrap.appendChild(empty);
    return wrap;
  }

  for (let i = 0; i < state.batches.length; i++) {
    wrap.appendChild(renderBatchPanel(i, state));
    const integrator = state.integrators[i];
    if (integrator) {
      wrap.appendChild(renderIntegratorCard(integrator, i, state, ctx, on));
    }
  }
  return wrap;
}

function renderBatchPanel(batchIndex: number, state: RunSchedulerState): HTMLElement {
  const panel = document.createElement("section");
  panel.className = "loop-step3-run-batch";
  if (state.currentBatchIndex === batchIndex && state.status === "running") {
    panel.classList.add("loop-step3-run-batch-current");
  }

  const head = document.createElement("div");
  head.className = "loop-step3-run-batch-head";
  const label = document.createElement("span");
  label.className = "loop-step3-run-batch-label";
  label.textContent = `batch ${batchIndex + 1}/${state.batches.length}`;
  const counter = document.createElement("span");
  counter.className = "loop-step3-run-batch-counter";
  const slugs = state.batches[batchIndex] ?? [];
  counter.textContent = `${slugs.length} phase${slugs.length === 1 ? "" : "s"} in parallel`;
  head.append(label, counter);
  panel.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "loop-step3-run-batch-grid";
  for (const slug of slugs) {
    const phaseIndex = state.phases.findIndex((p) => p.slug === slug);
    if (phaseIndex < 0) continue;
    grid.appendChild(renderPhaseCard(state.phases[phaseIndex], phaseIndex, state));
  }
  panel.appendChild(grid);
  return panel;
}

function renderPhaseCard(
  phase: PhaseState,
  phaseIndex: number,
  state: RunSchedulerState,
): HTMLElement {
  const card = document.createElement("article");
  card.className = "loop-step3-run-card";
  card.classList.add(`loop-step3-run-card-${phase.status}`);
  if (state.currentPhaseIndex === phaseIndex && state.status === "running") {
    card.classList.add("loop-step3-run-card-current");
  }
  if (phase.reviewerExhausted) {
    card.classList.add("loop-step3-run-card-exhausted");
  }

  const head = document.createElement("header");
  head.className = "loop-step3-run-card-head";
  const id = document.createElement("span");
  id.className = "loop-step3-run-card-id";
  id.textContent = phase.id;
  const name = document.createElement("span");
  name.className = "loop-step3-run-card-name";
  name.textContent = phase.name;
  const status = document.createElement("span");
  status.className = `loop-step3-run-status loop-step3-run-status-${phase.status}`;
  status.textContent = statusLabel(phase.status);
  head.append(id, name, status);
  card.appendChild(head);

  const bars = document.createElement("div");
  bars.className = "loop-step3-run-card-bars";
  for (const agent of SEQUENTIAL_AGENTS) {
    bars.appendChild(renderStageBar(phase.stages[agent], agent, state));
  }
  card.appendChild(bars);

  const tokens =
    phase.stages.analysis.tokensIn +
    phase.stages.analysis.tokensOut +
    phase.stages.implementation.tokensIn +
    phase.stages.implementation.tokensOut +
    phase.stages.review.tokensIn +
    phase.stages.review.tokensOut +
    phase.stages.knowledge.tokensIn +
    phase.stages.knowledge.tokensOut;
  if (tokens > 0) {
    const meta = document.createElement("div");
    meta.className = "loop-step3-run-card-meta";
    meta.textContent = `tokens ${formatNumber(tokens)}`;
    card.appendChild(meta);
  }

  return card;
}

function renderStageBar(
  stage: AgentStageState,
  agent: SequentialAgent,
  state: RunSchedulerState,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "loop-step3-run-bar";
  bar.classList.add(`loop-step3-run-bar-${stage.status}`);
  bar.title = `${agentShortLabel(agent)}: ${statusLabel(stage.status)}`;

  const label = document.createElement("span");
  label.className = "loop-step3-run-bar-label";
  label.textContent = agentShortLabel(agent);
  bar.appendChild(label);

  const fillWrap = document.createElement("span");
  fillWrap.className = "loop-step3-run-bar-track";
  const fill = document.createElement("span");
  fill.className = "loop-step3-run-bar-fill";
  fill.style.width = `${stageProgressPct(stage)}%`;
  fillWrap.appendChild(fill);
  bar.appendChild(fillWrap);

  if (agent === "review" && stage.retries > 0) {
    const retries = document.createElement("span");
    retries.className = "loop-step3-run-bar-retries";
    retries.textContent = `${stage.retries}/${state.settings?.maxRetries ?? 3}`;
    bar.appendChild(retries);
  }
  // In hybrid mode multiple phases run simultaneously, so we use the local
  // stage status rather than state.currentStage / currentPhaseIndex (which
  // only reflect the last write from the scheduler).
  if (stage.status === "running") {
    bar.classList.add("loop-step3-run-bar-active");
  }
  return bar;
}

function renderIntegratorCard(
  integrator: IntegratorState,
  batchIndex: number,
  state: RunSchedulerState,
  ctx: Step3RunContext,
  on: On,
): HTMLElement {
  const card = document.createElement("section");
  card.className = "loop-step3-run-integrator";
  card.classList.add(`loop-step3-run-integrator-${integrator.status}`);

  const head = document.createElement("div");
  head.className = "loop-step3-run-integrator-head";

  const icon = document.createElement("span");
  icon.className = "loop-step3-run-integrator-icon";
  icon.textContent = integratorIcon(integrator.status);
  head.appendChild(icon);

  const text = document.createElement("div");
  text.className = "loop-step3-run-integrator-text";
  const title = document.createElement("strong");
  title.textContent = `integrator · batch ${batchIndex + 1}`;
  const sub = document.createElement("div");
  sub.className = "loop-step3-run-integrator-sub";
  sub.textContent = integratorStatusLabel(integrator.status);
  text.append(title, sub);
  head.appendChild(text);

  if (integrator.tokensIn > 0 || integrator.tokensOut > 0) {
    const meta = document.createElement("span");
    meta.className = "loop-step3-run-integrator-meta";
    meta.textContent = `in ${formatNumber(integrator.tokensIn)} · out ${formatNumber(integrator.tokensOut)}`;
    head.appendChild(meta);
  }

  card.appendChild(head);

  if (integrator.message) {
    const msg = document.createElement("p");
    msg.className = "loop-step3-run-integrator-message";
    msg.textContent = integrator.message;
    card.appendChild(msg);
  }

  if (integrator.status === "conflict") {
    const conflictsBlock = document.createElement("div");
    conflictsBlock.className = "loop-step3-run-integrator-conflicts";
    if (integrator.conflicts.length > 0) {
      const title = document.createElement("div");
      title.className = "loop-step3-run-integrator-conflicts-title";
      title.textContent = "paths with overlapping changes:";
      conflictsBlock.appendChild(title);
      const list = document.createElement("ul");
      list.className = "loop-step3-run-integrator-conflicts-list";
      for (const path of integrator.conflicts) {
        const li = document.createElement("li");
        li.textContent = path;
        list.appendChild(li);
      }
      conflictsBlock.appendChild(list);
    }
    const actions = document.createElement("div");
    actions.className = "loop-step3-run-integrator-actions";
    actions.appendChild(conflictBtn("continue", "continue", state, ctx, on));
    actions.appendChild(conflictBtn("re-run batch", "rerun", state, ctx, on));
    actions.appendChild(conflictBtn("abort run", "abort", state, ctx, on));
    conflictsBlock.appendChild(actions);
    card.appendChild(conflictsBlock);
  }

  return card;
}

function conflictBtn(
  label: string,
  decision: ConflictDecision,
  state: RunSchedulerState,
  ctx: Step3RunContext,
  on: On,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "loop-btn loop-btn-ghost loop-step3-run-conflict-btn";
  if (decision === "abort") btn.classList.add("loop-step3-run-conflict-btn-danger");
  btn.textContent = label;
  // Only clickable while paused on a conflict; avoid double-trigger if the
  // user resumed by another path.
  btn.disabled = state.status !== "paused";
  on(btn, "click", () => {
    ctx.scheduler.resolveConflict(decision);
  });
  return btn;
}

function renderPhaseRow(phase: PhaseState, index: number, state: RunSchedulerState): HTMLElement {
  const row = document.createElement("div");
  row.className = "loop-step3-run-grid loop-step3-run-row";
  if (state.currentPhaseIndex === index) {
    row.classList.add("loop-step3-run-row-current");
  }
  if (phase.status === "warning") {
    row.classList.add("loop-step3-run-row-warning");
  } else if (phase.status === "error") {
    row.classList.add("loop-step3-run-row-error");
  } else if (phase.status === "done") {
    row.classList.add("loop-step3-run-row-done");
  }

  const phaseCell = document.createElement("div");
  phaseCell.className = "loop-step3-run-cell loop-step3-run-cell-phase";
  const phaseNum = document.createElement("span");
  phaseNum.className = "loop-step3-run-phase-id";
  phaseNum.textContent = phase.id;
  const phaseName = document.createElement("span");
  phaseName.className = "loop-step3-run-phase-name";
  phaseName.textContent = phase.name;
  const phaseStatus = document.createElement("span");
  phaseStatus.className = `loop-step3-run-status loop-step3-run-status-${phase.status}`;
  phaseStatus.textContent = statusLabel(phase.status);
  phaseCell.append(phaseNum, phaseName, phaseStatus);
  row.appendChild(phaseCell);

  for (const agent of SEQUENTIAL_AGENTS) {
    row.appendChild(renderStageCell(phase.stages[agent], agent, phase, state));
  }
  return row;
}

function renderStageCell(
  stage: AgentStageState,
  agent: SequentialAgent,
  phase: PhaseState,
  state: RunSchedulerState,
): HTMLElement {
  const cell = document.createElement("div");
  cell.className = "loop-step3-run-cell loop-step3-run-cell-stage";
  cell.classList.add(`loop-step3-run-stage-${stage.status}`);

  const top = document.createElement("div");
  top.className = "loop-step3-run-stage-top";

  const dot = document.createElement("span");
  dot.className = `loop-step3-run-dot loop-step3-run-dot-${stage.status}`;
  if (
    stage.status === "running" &&
    state.currentStage === agent &&
    state.phases[state.currentPhaseIndex]?.slug === phase.slug
  ) {
    dot.classList.add("loop-step3-run-dot-active");
  }
  top.appendChild(dot);

  const label = document.createElement("span");
  label.className = "loop-step3-run-stage-label";
  label.textContent = statusLabel(stage.status);
  top.appendChild(label);

  if (agent === "review" && stage.retries > 0) {
    const retries = document.createElement("span");
    retries.className = "loop-step3-run-retries";
    retries.textContent = `try ${stage.retries}/${state.settings?.maxRetries ?? 3}`;
    retries.title = "reviewer attempts consumed";
    top.appendChild(retries);
  }

  cell.appendChild(top);

  if (stage.tokensIn > 0 || stage.tokensOut > 0) {
    const meta = document.createElement("div");
    meta.className = "loop-step3-run-stage-meta";
    const parts: string[] = [];
    parts.push(`in ${formatNumber(stage.tokensIn)}`);
    parts.push(`out ${formatNumber(stage.tokensOut)}`);
    if (stage.costUsd > 0) parts.push(`$${stage.costUsd.toFixed(3)}`);
    meta.textContent = parts.join(" · ");
    cell.appendChild(meta);
  }

  if (stage.message) {
    const msg = document.createElement("div");
    msg.className = "loop-step3-run-stage-message";
    msg.textContent = stage.message;
    cell.appendChild(msg);
  }

  return cell;
}

function renderBudgetPanel(state: RunSchedulerState): HTMLElement {
  const panel = document.createElement("section");
  panel.className = "loop-step3-run-budget";

  const head = document.createElement("div");
  head.className = "loop-step3-run-budget-head";
  head.textContent = "Live consumption";
  panel.appendChild(head);

  const total = document.createElement("div");
  total.className = "loop-step3-run-budget-total";
  const used = state.totals.tokensIn + state.totals.tokensOut;
  const totalLbl = document.createElement("strong");
  totalLbl.textContent = `${formatNumber(used)} tokens`;
  const totalCost = document.createElement("span");
  totalCost.className = "loop-step3-run-budget-cost";
  totalCost.textContent = state.totals.costUsd > 0 ? ` · $${state.totals.costUsd.toFixed(3)}` : "";
  total.append(totalLbl, totalCost);
  panel.appendChild(total);

  const breakdown = document.createElement("ul");
  breakdown.className = "loop-step3-run-budget-breakdown";
  for (const role of ALL_AGENT_ROLES) {
    const agentTotals = state.byAgent[role];
    if (agentTotals.tokensIn === 0 && agentTotals.tokensOut === 0) continue;
    const li = document.createElement("li");
    li.className = "loop-step3-run-budget-row";
    const name = document.createElement("span");
    name.className = "loop-step3-run-budget-name";
    name.textContent = roleLabel(role);
    const tokens = document.createElement("span");
    tokens.className = "loop-step3-run-budget-tokens";
    tokens.textContent = `in ${formatNumber(agentTotals.tokensIn)} · out ${formatNumber(
      agentTotals.tokensOut,
    )}`;
    const cost = document.createElement("span");
    cost.className = "loop-step3-run-budget-row-cost";
    cost.textContent = agentTotals.costUsd > 0 ? `$${agentTotals.costUsd.toFixed(3)}` : "—";
    li.append(name, tokens, cost);
    breakdown.appendChild(li);
  }
  panel.appendChild(breakdown);

  if (state.message) {
    const msg = document.createElement("p");
    msg.className = "loop-step3-run-message";
    msg.textContent = state.message;
    panel.appendChild(msg);
  }

  return panel;
}
