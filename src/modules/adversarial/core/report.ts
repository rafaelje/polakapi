// Deterministic `report.md` renderer.
//
// Never invokes an LLM — totals, counts, and the verdict are computed from the
// final ledger and settings in pure TypeScript. This is what makes the report
// reproducible for a given (diff, ledger).

import type { DebateSettings, DebateState, Finding, FindingLedger, Severity } from "../types";
import { SEVERITY_RANK, severityAtOrAbove } from "../types";

export type Verdict = "APPROVED" | "CHANGES REQUESTED";

export interface VerdictSummary {
  verdict: Verdict;
  blockingSeverity: Severity;
  confirmedBlocking: Finding[];
  confirmedNonBlocking: Finding[];
  disputed: Finding[];
  withdrawnCount: number;
}

export function computeVerdict(ledger: FindingLedger, blockingSeverity: Severity): VerdictSummary {
  const confirmed = ledger.findings.filter((f) => f.status === "confirmed");
  const disputed = ledger.findings.filter((f) => f.status === "disputed");
  const withdrawnCount = ledger.findings.filter((f) => f.status === "withdrawn").length;

  const confirmedBlocking = confirmed.filter((f) =>
    severityAtOrAbove(f.severity, blockingSeverity),
  );
  const confirmedNonBlocking = confirmed.filter(
    (f) => !severityAtOrAbove(f.severity, blockingSeverity),
  );

  const sortBySev = (a: Finding, b: Finding): number =>
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.id.localeCompare(b.id);

  return {
    verdict: confirmedBlocking.length > 0 ? "CHANGES REQUESTED" : "APPROVED",
    blockingSeverity,
    confirmedBlocking: confirmedBlocking.slice().sort(sortBySev),
    confirmedNonBlocking: confirmedNonBlocking.slice().sort(sortBySev),
    disputed: disputed.slice().sort(sortBySev),
    withdrawnCount,
  };
}

export function renderReport(state: DebateState): string {
  const { settings, findings, totals, diffTruncated } = state;
  const filesExcluded = state.diffFilesExcluded ?? [];
  const filesTruncated = state.diffFilesTruncated ?? [];
  const summary = computeVerdict(findings, settings.blockingSeverity);
  const projectName = deriveProjectName(settings.projectPath);

  const lines: string[] = [];
  lines.push("# /adversarial review");
  lines.push("");
  lines.push(`**Project:** ${projectName}`);
  if (settings.diffMode === "working") {
    lines.push(`**Diff source:** working tree (uncommitted changes vs \`HEAD\`)`);
  } else {
    lines.push(
      `**Base ref:** \`${settings.baseRef}\`  |  **Merge base:** \`${settings.mergeBase}\``,
    );
  }
  lines.push(`**Head:** \`${shortSha(settings.headSha)}\`  |  **Rounds:** ${settings.rounds}`);
  if (settings.scopePaths.length > 0) {
    lines.push(`**Scope:** \`${settings.scopePaths.join("`, `")}\``);
  }
  lines.push(
    `**Critic:** ${slotLabel(settings.critic)}  |  **Defender:** ${slotLabel(settings.defender)}`,
  );
  lines.push("");
  lines.push(
    `**Tokens:** in ${totals.tokensIn.toLocaleString()} / out ${totals.tokensOut.toLocaleString()}  |  **Cost:** ${formatUsd(totals.costUsd)}`,
  );
  if (filesExcluded.length > 0) {
    lines.push("");
    lines.push(
      `> ℹ️ Auto-excluded ${filesExcluded.length} generated file${filesExcluded.length === 1 ? "" : "s"} from review: ${formatPathList(filesExcluded)}. Re-scope explicitly to include them.`,
    );
  }
  if (diffTruncated) {
    lines.push("");
    const bits: string[] = [];
    if (filesTruncated.length > 0) {
      bits.push(
        `${filesTruncated.length} file${filesTruncated.length === 1 ? "" : "s"} trimmed at the per-file cap (${formatPathList(filesTruncated)})`,
      );
    }
    if (filesTruncated.length === 0) {
      bits.push("diff exceeded the total size cap");
    }
    lines.push(
      `> ⚠️ Diff was cut before review — ${bits.join("; ")}. Findings may miss context past the cutoff.`,
    );
  }

  lines.push("");
  lines.push(
    `## Verdict: ${summary.verdict === "APPROVED" ? "✅ APPROVED" : "🚫 CHANGES REQUESTED"} (threshold: ${settings.blockingSeverity})`,
  );
  lines.push("");
  lines.push(
    `- confirmed: ${summary.confirmedBlocking.length + summary.confirmedNonBlocking.length} (${summary.confirmedBlocking.length} at/above threshold)`,
  );
  lines.push(`- disputed: ${summary.disputed.length}`);
  lines.push(`- withdrawn: ${summary.withdrawnCount}`);

  lines.push("");
  lines.push("## Confirmed — blocking");
  if (summary.confirmedBlocking.length === 0) {
    lines.push("_None._");
  } else {
    for (const f of summary.confirmedBlocking) renderFinding(lines, f);
  }

  lines.push("");
  lines.push("## Confirmed — below threshold");
  if (summary.confirmedNonBlocking.length === 0) {
    lines.push("_None._");
  } else {
    for (const f of summary.confirmedNonBlocking) renderFinding(lines, f);
  }

  lines.push("");
  lines.push("## Disputed");
  if (summary.disputed.length === 0) {
    lines.push("_None._");
  } else {
    for (const f of summary.disputed) renderDisputed(lines, f);
  }

  lines.push("");
  lines.push(`## Withdrawn (${summary.withdrawnCount})`);
  const withdrawn = findings.findings.filter((f) => f.status === "withdrawn");
  if (withdrawn.length === 0) {
    lines.push("_None._");
  } else {
    for (const f of withdrawn) {
      lines.push(`- \`${f.id}\` ${f.file}${f.line ? `:${f.line}` : ""} — ${f.claim}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function renderFinding(lines: string[], f: Finding): void {
  const anchor = f.line ? `${f.file}:${f.line}` : f.file;
  lines.push("");
  lines.push(`### ${f.id} \`${f.severity}\` — ${f.claim}`);
  lines.push(`**Location:** \`${anchor}\``);
  const criticRounds = f.history.filter((h) => h.role === "critic");
  const defenderRounds = f.history.filter((h) => h.role === "defender");
  const criticLast = criticRounds[criticRounds.length - 1];
  const defenderLast = defenderRounds[defenderRounds.length - 1];
  if (criticLast) {
    lines.push("");
    lines.push(`**Critic (R${criticLast.round}, ${criticLast.action}):** ${criticLast.argument}`);
  }
  if (defenderLast) {
    lines.push("");
    lines.push(
      `**Defender (R${defenderLast.round}, ${defenderLast.action}):** ${defenderLast.argument}`,
    );
  }
}

function renderDisputed(lines: string[], f: Finding): void {
  const anchor = f.line ? `${f.file}:${f.line}` : f.file;
  lines.push("");
  lines.push(`### ${f.id} \`${f.severity}\` — ${f.claim}`);
  lines.push(`**Location:** \`${anchor}\``);
  const critic = lastByRole(f, "critic");
  const defender = lastByRole(f, "defender");
  if (critic) {
    lines.push("");
    lines.push(`**Critic's last (R${critic.round}, ${critic.action}):** ${critic.argument}`);
  }
  if (defender) {
    lines.push("");
    lines.push(
      `**Defender's last (R${defender.round}, ${defender.action}):** ${defender.argument}`,
    );
  }
}

function lastByRole(f: Finding, role: "critic" | "defender"): Finding["history"][number] | null {
  for (let i = f.history.length - 1; i >= 0; i--) {
    if (f.history[i].role === role) return f.history[i];
  }
  return null;
}

function slotLabel(slot: DebateSettings["critic"]): string {
  const effort = slot.effort === "default" ? "" : ` @${slot.effort}`;
  return `${slot.cli} · ${slot.model}${effort}`;
}

function shortSha(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) : sha;
}

function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$0.00";
  return `$${usd.toFixed(4)}`;
}

function deriveProjectName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatPathList(files: string[], max = 5): string {
  const quoted = (f: string): string => `\`${f}\``;
  if (files.length <= max) return files.map(quoted).join(", ");
  const head = files.slice(0, max).map(quoted).join(", ");
  return `${head}, +${files.length - max} more`;
}
