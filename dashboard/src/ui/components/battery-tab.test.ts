import { afterEach, describe, expect, it } from "vitest";
import "./battery-tab.js";
import "./stat-tile.js";
import type { BatteryTab } from "./battery-tab.js";
import type { BatteryDetail, UnavailableBatteryField } from "../../protocol/index.js";
import { tileLabels, tileValues } from "./test-utils.js";

const SAMPLE: BatteryDetail = {
  fullCapacityMah: 14000,
  remainingCapacityMah: 14000,
  chargeOfFullPercent: 100,
  chargeOfDesignPercent: 100,
  packCurrentA: 0,
  packVoltageV: 41.2,
  packTemperatureC: 20,
  heaterActive: false,
  charging: false,
  discharging: false,
  cellsInSeries: 0,
  cellsInParallel: 0,
  maxChargeVoltageV: 0,
  maxChargeCurrentA: 0,
};

async function mount(
  detail?: BatteryDetail,
  unavailableFields?: ReadonlySet<UnavailableBatteryField>,
): Promise<BatteryTab> {
  const el = document.createElement("battery-tab") as BatteryTab;
  el.detail = detail;
  if (unavailableFields) el.unavailableFields = unavailableFields;
  document.body.append(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<battery-tab>", () => {
  it("shows a waiting message before any battery data has arrived", async () => {
    const el = await mount(undefined);
    expect(el.shadowRoot?.textContent).toContain("Waiting");
  });

  it("renders the pack voltage and reports idle when neither charging nor discharging", async () => {
    const el = await mount(SAMPLE);
    const values = tileValues(el);
    expect(values).toContain("41.20");
    expect(values).toContain("idle");
  });

  it("reports charging state distinctly", async () => {
    const el = await mount({ ...SAMPLE, charging: true, packCurrentA: -2.5 });
    expect(tileValues(el)).toContain("charging");
  });

  it("shows every field when nothing is marked unavailable", async () => {
    const el = await mount(SAMPLE);
    const labels = tileLabels(el);
    expect(labels).toContain("pack temp");
    expect(labels).toContain("cells");
    expect(labels).toContain("max charge voltage");
  });

  it("hides fields the profile has marked unavailable, without touching the rest", async () => {
    const el = await mount(
      SAMPLE,
      new Set<UnavailableBatteryField>([
        "packTemperatureC",
        "chargeOfFullPercent",
        "chargeOfDesignPercent",
        "fullCapacityMah",
        "remainingCapacityMah",
        "cells",
        "maxChargeVoltageV",
        "maxChargeCurrentA",
      ]),
    );
    const labels = tileLabels(el);
    expect(labels).not.toContain("pack temp");
    expect(labels).not.toContain("charge, of full capacity");
    expect(labels).not.toContain("charge, of design capacity");
    expect(labels).not.toContain("full capacity");
    expect(labels).not.toContain("remaining capacity");
    expect(labels).not.toContain("cells");
    expect(labels).not.toContain("max charge voltage");
    expect(labels).not.toContain("max charge current");
    // Still-working fields survive untouched.
    expect(labels).toContain("pack voltage");
    expect(labels).toContain("pack current");
    expect(labels).toContain("state");
  });
});
