import { EMPTY_TOTALS, sumTotals, type DailyBucket, type TokenTotals } from "./types";

/**
 * Sum tokens from buckets whose date falls within the last `days` calendar
 * days (UTC), anchored on `now` and inclusive of that day. Filters by date
 * value instead of position so gaps in history and the sentinel `"unknown"`
 * date don't skew results. `days <= 0` returns zeros.
 */
export function sumLastDays(
  buckets: readonly DailyBucket[],
  days: number,
  pick: (bucket: DailyBucket) => TokenTotals,
  now: number = Date.now(),
): TokenTotals {
  if (days <= 0) return EMPTY_TOTALS;
  let acc = EMPTY_TOTALS;
  if (!Number.isFinite(days)) {
    for (const bucket of buckets) {
      if (isCalendarDate(bucket.date)) acc = sumTotals(acc, pick(bucket));
    }
    return acc;
  }
  const today = toIsoDate(now);
  const cutoff = toIsoDate(now - (days - 1) * 86_400_000);
  for (const bucket of buckets) {
    if (!isCalendarDate(bucket.date)) continue;
    if (bucket.date < cutoff || bucket.date > today) continue;
    acc = sumTotals(acc, pick(bucket));
  }
  return acc;
}

function toIsoDate(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function formatTokens(value: number): string {
  if (value === 0) return "0";
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`;
}
