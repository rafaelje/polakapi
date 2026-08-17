export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface DailyBucket {
  date: string;
  claude: TokenTotals;
  codex: TokenTotals;
}

export interface ProviderTotals {
  claude: TokenTotals;
  codex: TokenTotals;
}

export interface UsageWarning {
  provider: string;
  message: string;
}

export interface CodexRateWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimits {
  planType: string | null;
  capturedAt: string | null;
  primary: CodexRateWindow | null;
  secondary: CodexRateWindow | null;
  /** "live" when refreshed from the API, "snapshot" when read from JSONL. */
  source: "live" | "snapshot";
}

export interface ClaudeBlock {
  startedAt: number;
  endsAt: number;
  tokens: TokenTotals;
}

export interface AuthoritativeWindow {
  usedPercent: number;
  resetsAt: number | null;
}

export interface ClaudeAuthoritative {
  session: AuthoritativeWindow | null;
  weekly: AuthoritativeWindow | null;
  fableWeekly: AuthoritativeWindow | null;
}

export interface UsageReport {
  daily: DailyBucket[];
  totals: ProviderTotals;
  warnings: UsageWarning[];
  codexLimits: CodexRateLimits | null;
  claudeBlock: ClaudeBlock | null;
  claudeAuthoritative: ClaudeAuthoritative | null;
  nowSeconds: number;
}

export type ClaudePlanTier = "pro" | "max5x" | "max20x";

export interface ClaudePlanSpec {
  id: ClaudePlanTier;
  label: string;
  price: string;
  blockTokenCap: number;
}

/**
 * Approximate token caps for a single 5-hour Claude Code session block.
 * Anthropic publishes prompt-count guidance ("~45 prompts on Pro") rather
 * than token thresholds, and Max is described as 5×/20× the Pro allowance,
 * so these numbers are back-derived from observed `/usage` reports (a Max 5×
 * session at ~21M summed tokens sat at ~14%, i.e. ~150M cap). The panel
 * shows this as an approximation — Claude's own `/usage` is authoritative.
 */
export const CLAUDE_PLANS: readonly ClaudePlanSpec[] = [
  { id: "pro", label: "Pro", price: "$20", blockTokenCap: 30_000_000 },
  { id: "max5x", label: "Max 5×", price: "$100", blockTokenCap: 150_000_000 },
  { id: "max20x", label: "Max 20×", price: "$200", blockTokenCap: 600_000_000 },
] as const;

export function claudePlan(tier: ClaudePlanTier): ClaudePlanSpec {
  return CLAUDE_PLANS.find((p) => p.id === tier) ?? CLAUDE_PLANS[0];
}

export const EMPTY_TOTALS: TokenTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
};

export function sumTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    total: a.total + b.total,
  };
}
