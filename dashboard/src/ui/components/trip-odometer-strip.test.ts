import { afterEach, describe, expect, it } from "vitest";
import "./trip-odometer-strip.js";
import "./stat-tile.js";
import type { TripOdometerStrip } from "./trip-odometer-strip.js";
import type { ControllerDetail, TripStats } from "../../protocol/index.js";
import { tileValues } from "./test-utils.js";

async function mount(
  detail?: ControllerDetail,
  trip?: TripStats,
): Promise<TripOdometerStrip> {
  const el = document.createElement("trip-odometer-strip") as TripOdometerStrip;
  el.detail = detail;
  el.trip = trip;
  document.body.append(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<trip-odometer-strip>", () => {
  it("shows placeholders before any data has arrived", async () => {
    const el = await mount();
    expect(tileValues(el)).toEqual(["—", "—", "—", "—", "—"]);
  });

  it("renders average and max speed alongside trip/odometer/range", async () => {
    const trip = { avgSpeedKmh: 18.4, maxSpeedKmh: 32.1 } as TripStats;
    const el = await mount(undefined, trip);
    const values = tileValues(el);
    expect(values).toContain("18.4");
    expect(values).toContain("32.1");
  });
});
