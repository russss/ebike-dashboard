/** Dispatched by `<stat-tile>`/`<hero-readout>` when clicked with a `metricId` set. */
export interface MetricSelectedDetail {
  readonly metricId: string;
  readonly label: string;
  readonly unit: string;
  /** Decimal places the tile itself displays this value with — see {@link decimalsOf}. */
  readonly decimals: number;
}

export const METRIC_SELECTED_EVENT = "metric-selected";

/**
 * Reads the decimal precision straight off a tile's own already-formatted value string (e.g.
 * `"41.20"` -> 2), so the history graph matches whatever precision that specific tile happens to
 * use — never a second, separately-maintained guess at "how many decimals does this metric get."
 */
export function decimalsOf(formattedValue: string): number {
  const i = formattedValue.indexOf(".");
  return i === -1 ? 0 : formattedValue.length - i - 1;
}
