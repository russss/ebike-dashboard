import { describe, expect, it } from "vitest";
import { torquePercent } from "./torque.js";

describe("torquePercent", () => {
  it("is 0% at the resting baseline voltage", () => {
    expect(torquePercent(238, 238)).toBe(0);
  });

  it("is 100% at 0mV", () => {
    expect(torquePercent(0, 238)).toBe(100);
  });

  it("is proportional in between", () => {
    expect(torquePercent(119, 238)).toBeCloseTo(50);
  });

  it("clamps above 100% instead of reporting more torque than the sensor's range allows", () => {
    // A reading below 0 shouldn't happen, but a noisy sample dipping past the presumed floor
    // shouldn't produce a nonsensical >100% either.
    expect(torquePercent(-10, 238)).toBe(100);
  });

  it("clamps below 0% for a reading above the observed baseline", () => {
    // The baseline is "highest voltage observed so far" — a single low-noise sample that's
    // briefly higher than every prior sample (before the baseline catches up) shouldn't read
    // as negative torque.
    expect(torquePercent(250, 238)).toBe(0);
  });

  it("is 0% when no baseline has been established yet", () => {
    expect(torquePercent(150, 0)).toBe(0);
  });
});
