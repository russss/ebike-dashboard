import { describe, expect, it } from "vitest";
import { MetricHistory } from "./metric-history.js";

describe("MetricHistory", () => {
  it("records points under a metric id, keeping insertion order", () => {
    const history = new MetricHistory();
    history.record("controller.speedKmh", 10, 1000);
    history.record("controller.speedKmh", 12, 2000);

    expect(history.get("controller.speedKmh")).toEqual([
      { t: 1000, value: 10 },
      { t: 2000, value: 12 },
    ]);
  });

  it("keeps separate metrics independent", () => {
    const history = new MetricHistory();
    history.record("controller.speedKmh", 10, 1000);
    history.record("battery.packVoltageV", 41.2, 1000);

    expect(history.get("controller.speedKmh")).toHaveLength(1);
    expect(history.get("battery.packVoltageV")).toHaveLength(1);
  });

  it("returns an empty array for a metric that's never been recorded", () => {
    const history = new MetricHistory();
    expect(history.get("nope")).toEqual([]);
  });

  it("defaults the timestamp to now when not given one", () => {
    const history = new MetricHistory();
    const before = Date.now();
    history.record("controller.speedKmh", 10);
    const after = Date.now();

    const [point] = history.get("controller.speedKmh");
    expect(point!.t).toBeGreaterThanOrEqual(before);
    expect(point!.t).toBeLessThanOrEqual(after);
  });

  it("returns a fresh array reference each call, so a Lit property binding notices new points", () => {
    // record() mutates its internal array in place; if get() returned that same reference, a
    // `.points=${history.get(id)}` binding would never re-render as new points arrive, since
    // Lit's default change check is reference equality.
    const history = new MetricHistory();
    history.record("controller.speedKmh", 10, 1000);
    const first = history.get("controller.speedKmh");
    const second = history.get("controller.speedKmh");
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it("clears every metric on reset", () => {
    const history = new MetricHistory();
    history.record("controller.speedKmh", 10, 1000);
    history.reset();
    expect(history.get("controller.speedKmh")).toEqual([]);
  });
});
