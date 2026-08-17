import { EMPTY_TOTALS, sumTotals, type DailyBucket, type TokenTotals } from "./types";

// Buckets are pre-sorted newest first by the Rust command.
export function sumLastDays(
  buckets: readonly DailyBucket[],
  days: number,
  pick: (bucket: DailyBucket) => TokenTotals,
): TokenTotals {
  if (days <= 0) return EMPTY_TOTALS;
  let acc = EMPTY_TOTALS;
  for (const bucket of buckets.slice(0, days)) {
    acc = sumTotals(acc, pick(bucket));
  }
  return acc;
}

export function formatTokens(value: number): string {
  if (value === 0) return "0";
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`;
}
