import { afterEach, describe, expect, it } from "vitest";
import "./identity-tab.js";
import "./stat-tile.js";
import type { IdentityTab } from "./identity-tab.js";
import type { ControllerDetail, ModuleIdentities } from "../../protocol/index.js";
import { tileValues } from "./test-utils.js";

const BLANK = { hardwareVersion: "", firmwareVersion: "", model: "", serialNumber: "", manufacturer: "" };

async function mount(
  identities?: ModuleIdentities,
  controller?: ControllerDetail,
): Promise<IdentityTab> {
  const el = document.createElement("identity-tab") as IdentityTab;
  el.identities = identities;
  el.controller = controller;
  document.body.append(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<identity-tab>", () => {
  it("shows a waiting message before any identity data has arrived", async () => {
    const el = await mount(undefined);
    expect(el.shadowRoot?.textContent).toContain("Waiting");
  });

  it("renders one section per module with its own fields", async () => {
    const el = await mount({
      controller: { ...BLANK, hardwareVersion: "CR A101.C 1.1", firmwareVersion: "CRS20RC3615F801026.4" },
      battery: BLANK,
      meter: { ...BLANK, serialNumber: "938513864N00651", manufacturer: "ADO-EBIKE" },
      sensor: BLANK,
    });
    const values = tileValues(el);
    expect(values).toContain("CR A101.C 1.1");
    expect(values).toContain("938513864N00651");
    expect(values).toContain("ADO-EBIKE");
    expect(el.shadowRoot?.querySelectorAll("section")).toHaveLength(4);
  });

  it("shows a 'no data' status for a module with a blank identity, not five empty rows", async () => {
    const el = await mount({ controller: BLANK, battery: BLANK, meter: BLANK, sensor: BLANK });
    expect(tileValues(el)).toEqual(["no data", "no data", "no data", "no data"]);
  });

  it("shows a configuration section with wheel diameter and speed limit once controller detail arrives", async () => {
    const controller = {
      wheelDiameterInches: 20,
      speedLimitKmh: 25,
    } as ControllerDetail;
    const el = await mount(
      { controller: BLANK, battery: BLANK, meter: BLANK, sensor: BLANK },
      controller,
    );
    const values = tileValues(el);
    expect(values).toContain("20.0");
    expect(values).toContain("25");
    expect(el.shadowRoot?.querySelectorAll("section")).toHaveLength(5);
  });

  it("omits the configuration section before controller detail has arrived", async () => {
    const el = await mount({ controller: BLANK, battery: BLANK, meter: BLANK, sensor: BLANK });
    expect(el.shadowRoot?.querySelectorAll("section")).toHaveLength(4);
  });
});
