import { afterEach, describe, expect, it, vi } from "vitest";
import "./metric-chart-modal.js";
import type { MetricChartModal } from "./metric-chart-modal.js";
import type { MetricPoint } from "../metric-history.js";

function points(values: number[], startT = 0, stepMs = 1000): MetricPoint[] {
  return values.map((value, i) => ({ t: startT + i * stepMs, value }));
}

async function mount(props: Partial<MetricChartModal>): Promise<MetricChartModal> {
  const el = document.createElement("metric-chart-modal") as MetricChartModal;
  Object.assign(el, props);
  document.body.append(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<metric-chart-modal>", () => {
  it("renders the label and unit in the header", async () => {
    const el = await mount({ label: "voltage", unit: "V", points: points([41, 41.2, 41.1]) });
    expect(el.shadowRoot?.querySelector("h2")?.textContent).toContain("voltage");
    expect(el.shadowRoot?.textContent).toContain("V");
  });

  it("shows current/min/max, formatted to the given decimal precision", async () => {
    const el = await mount({
      label: "voltage",
      unit: "V",
      decimals: 2,
      points: points([41.0, 41.5, 40.8]),
    });
    const values = [...(el.shadowRoot?.querySelectorAll(".stat .value") ?? [])].map(
      (n) => n.textContent,
    );
    expect(values).toEqual(["40.80", "40.80", "41.50"]); // current, min, max
  });

  it("shows a placeholder instead of a broken chart with fewer than two points", async () => {
    const el = await mount({ label: "voltage", points: [{ t: 0, value: 41 }] });
    expect(el.shadowRoot?.textContent).toContain("Not enough data yet");
    expect(el.shadowRoot?.querySelector("svg polyline")).toBeNull();
  });

  it("renders a line for two or more points", async () => {
    const el = await mount({ label: "voltage", points: points([41, 41.2]) });
    expect(el.shadowRoot?.querySelector("svg polyline.line")).not.toBeNull();
  });

  it("dispatches close when the close button is clicked", async () => {
    const el = await mount({ label: "voltage", points: points([41, 41.2]) });
    const handler = vi.fn();
    el.addEventListener("metric-chart-close", handler);
    el.shadowRoot?.querySelector<HTMLButtonElement>(".close-button")?.click();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("dispatches close on Escape", async () => {
    const el = await mount({ label: "voltage", points: points([41, 41.2]) });
    const handler = vi.fn();
    el.addEventListener("metric-chart-close", handler);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("stops listening for Escape once removed from the DOM", async () => {
    const el = await mount({ label: "voltage", points: points([41, 41.2]) });
    const handler = vi.fn();
    el.addEventListener("metric-chart-close", handler);
    el.remove();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches close when the backdrop itself is clicked, not when the header is", async () => {
    const el = await mount({ label: "voltage", points: points([41, 41.2]) });
    const handler = vi.fn();
    el.addEventListener("metric-chart-close", handler);

    el.shadowRoot?.querySelector("header")?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(handler).not.toHaveBeenCalled();

    el.shadowRoot?.querySelector("div")?.dispatchEvent(new Event("click"));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("locks background scroll while open and restores it on close", async () => {
    const originalOverflow = document.body.style.overflow;
    const el = await mount({ label: "voltage", points: points([41, 41.2]) });
    expect(document.body.style.overflow).toBe("hidden");

    el.remove();
    expect(document.body.style.overflow).toBe(originalOverflow);
  });

  it("draws a flat chart without dividing by zero when every value is identical", async () => {
    const el = await mount({ label: "voltage", points: points([41, 41, 41]) });
    expect(() => el.shadowRoot?.querySelector("svg polyline.line")).not.toThrow();
    expect(el.shadowRoot?.querySelector("svg polyline.line")).not.toBeNull();
  });
});
