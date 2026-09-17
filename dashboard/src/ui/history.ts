/**
 * A rolling, time-windowed history of the headline live numbers, used to drive the sparkline
 * trend on each de-emphasised hero tile. This is presentation state, not protocol state — it
 * lives here rather than on `AdoBike`, which only ever reports the latest sample.
 */

export interface HistorySample {
  readonly t: number;
  readonly speedKmh: number;
  readonly batteryPercent: number;
  readonly assistLevel: number;
}

/** A few minutes is enough to see a trend at a glance without the sparkline going stale. */
export const HISTORY_WINDOW_MS = 5 * 60 * 1000;

/** Returns a new array — appends `sample` and drops anything older than the window. */
export function pushHistorySample(
  history: readonly HistorySample[],
  sample: HistorySample,
): HistorySample[] {
  const cutoff = sample.t - HISTORY_WINDOW_MS;
  return [...history.filter((s) => s.t >= cutoff), sample];
}
