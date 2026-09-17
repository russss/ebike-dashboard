/**
 * Full-resolution, per-metric time series for the *current* connection — what backs the
 * click-a-tile-to-see-its-graph modal. Holds already-scaled display values (exactly what's on
 * screen), not raw register ints — for the separate raw, pre-scaling capture pipeline that
 * backs session recording/download, see `protocol/raw-samples.ts`. Unlike that pipeline, this
 * one is never persisted: it exists purely to redraw what's already visible, over time, and is
 * cleared on every disconnect.
 */
export interface MetricPoint {
  readonly t: number;
  readonly value: number;
}

export class MetricHistory {
  #series = new Map<string, MetricPoint[]>();

  record(metric: string, value: number, t: number = Date.now()): void {
    let points = this.#series.get(metric);
    if (!points) {
      points = [];
      this.#series.set(metric, points);
    }
    points.push({ t, value });
  }

  /**
   * A fresh array every call, even when nothing changed — a Lit `@property` binding only
   * re-renders on reference inequality, and `record()` mutates its internal array in place
   * rather than replacing it, so returning that same reference here would make the chart modal
   * look frozen even as new points keep arriving underneath it.
   */
  get(metric: string): readonly MetricPoint[] {
    return [...(this.#series.get(metric) ?? [])];
  }

  reset(): void {
    this.#series.clear();
  }
}
