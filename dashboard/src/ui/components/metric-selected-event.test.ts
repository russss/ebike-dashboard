import { describe, expect, it } from "vitest";
import { decimalsOf } from "./metric-selected-event.js";

describe("decimalsOf", () => {
  it("counts digits after the decimal point", () => {
    expect(decimalsOf("41.20")).toBe(2);
    expect(decimalsOf("24.3")).toBe(1);
  });

  it("is 0 for an integer-formatted value, with no decimal point at all", () => {
    expect(decimalsOf("100")).toBe(0);
    expect(decimalsOf("0")).toBe(0);
  });

  it("handles a negative value", () => {
    expect(decimalsOf("-1.50")).toBe(2);
  });
});
