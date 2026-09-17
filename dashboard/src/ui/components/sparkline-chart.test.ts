import { afterEach, describe, expect, it } from "vitest";
import "./sparkline-chart.js";
import type { SparklineChart } from "./sparkline-chart.js";

async function mount(values: number[]): Promise<SparklineChart> {
  const el = document.createElement("sparkline-chart") as SparklineChart;
  el.values = values;
  document.body.append(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<sparkline-chart>", () => {
  it("renders an empty svg with fewer than two points", async () => {
    const el = await mount([5]);
    expect(el.shadowRoot?.querySelector("polyline")).toBeNull();
  });

  it("renders one point per value in the polyline", async () => {
    const el = await mount([1, 2, 3, 2, 1]);
    const points = el.shadowRoot?.querySelector("polyline")?.getAttribute("points") ?? "";
    expect(points.trim().split(/\s+/)).toHaveLength(5);
  });

  it("marks the most recent value with a dot", async () => {
    const el = await mount([1, 2, 3]);
    expect(el.shadowRoot?.querySelector("circle")).not.toBeNull();
  });

  it("doesn't divide by zero when every value is identical", async () => {
    const el = await mount([5, 5, 5]);
    const points = el.shadowRoot?.querySelector("polyline")?.getAttribute("points") ?? "";
    // flat line at the vertical midpoint (height/2 = 9), not NaN
    expect(points).not.toContain("NaN");
    expect(points).toContain(",9.0");
  });
});
