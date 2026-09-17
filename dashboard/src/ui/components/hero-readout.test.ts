import { afterEach, describe, expect, it, vi } from "vitest";
import "./hero-readout.js";
import type { HeroReadout } from "./hero-readout.js";
import type { MetricSelectedDetail } from "./metric-selected-event.js";

async function mount(props: Partial<HeroReadout>): Promise<HeroReadout> {
  const el = document.createElement("hero-readout") as HeroReadout;
  Object.assign(el, props);
  document.body.append(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<hero-readout>", () => {
  it("renders the value, unit and label", async () => {
    const el = await mount({ value: "24.3", unit: "km/h", label: "speed" });
    const text = el.shadowRoot?.textContent ?? "";
    expect(text).toContain("24.3");
    expect(text).toContain("km/h");
    expect(text).toContain("speed");
  });

  it("omits the sparkline when there's fewer than two history samples", async () => {
    const el = await mount({ value: "0", history: [1] });
    expect(el.shadowRoot?.querySelector("sparkline-chart")).toBeNull();
  });

  it("renders a sparkline once there are at least two history samples", async () => {
    const el = await mount({ value: "0", history: [1, 2, 3] });
    expect(el.shadowRoot?.querySelector("sparkline-chart")).not.toBeNull();
  });

  it("stays inert without a metricId", async () => {
    const el = await mount({ value: "24.3", label: "speed" });
    const handler = vi.fn();
    el.addEventListener("metric-selected", handler);
    el.click();

    expect(el.hasAttribute("role")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches metric-selected when clicked with a metricId", async () => {
    const el = await mount({
      value: "24.3",
      unit: "km/h",
      label: "speed",
      metricId: "hero.speed",
    });
    const handler = vi.fn();
    el.addEventListener("metric-selected", handler);
    el.click();

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0]![0] as CustomEvent<MetricSelectedDetail>).detail;
    expect(detail).toEqual({
      metricId: "hero.speed",
      label: "speed",
      unit: "km/h",
      decimals: 1, // from the "24.3" value string
    });
  });
});
