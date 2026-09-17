import { afterEach, describe, expect, it, vi } from "vitest";
import "./stat-tile.js";
import type { StatTile } from "./stat-tile.js";
import type { MetricSelectedDetail } from "./metric-selected-event.js";

async function mount(attrs: Record<string, string>): Promise<StatTile> {
  const el = document.createElement("stat-tile") as StatTile;
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  document.body.append(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<stat-tile>", () => {
  it("renders its label, value and unit", async () => {
    const el = await mount({ label: "voltage", value: "41.2", unit: "V" });
    const text = el.shadowRoot?.textContent ?? "";
    expect(text).toContain("voltage");
    expect(text).toContain("41.2");
    expect(text).toContain("V");
  });

  it("reflects the tone attribute for styling hooks", async () => {
    const el = await mount({ label: "fault", value: "3", tone: "fault" });
    expect(el.getAttribute("tone")).toBe("fault");
  });

  it("omits the unit span when no unit is given", async () => {
    const el = await mount({ label: "assist", value: "3" });
    expect(el.shadowRoot?.querySelector(".unit")).toBeNull();
  });

  it("stays inert — no role, no tabindex, no event — without a metricId", async () => {
    const el = await mount({ label: "cells", value: "13s 1p" });
    const handler = vi.fn();
    el.addEventListener("metric-selected", handler);
    el.click();

    expect(el.hasAttribute("role")).toBe(false);
    expect(el.hasAttribute("tabindex")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches metric-selected with its own label/unit when clicked with a metricId", async () => {
    const el = await mount({
      label: "voltage",
      value: "41.2",
      unit: "V",
      metricid: "controller.batteryVoltageV",
    });
    const handler = vi.fn();
    el.addEventListener("metric-selected", handler);
    el.click();

    expect(el.getAttribute("role")).toBe("button");
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0]![0] as CustomEvent<MetricSelectedDetail>).detail;
    expect(detail).toEqual({
      metricId: "controller.batteryVoltageV",
      label: "voltage",
      unit: "V",
      decimals: 1, // from the "41.2" value string
    });
  });

  it("activates on Enter and Space, not other keys", async () => {
    const el = await mount({ label: "voltage", value: "41.2", metricid: "controller.batteryVoltageV" });
    const handler = vi.fn();
    el.addEventListener("metric-selected", handler);

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(handler).not.toHaveBeenCalled();

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
