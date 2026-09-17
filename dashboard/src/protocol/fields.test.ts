import { describe, expect, it } from "vitest";
import {
  decodeBatteryDetail,
  decodeControllerDetail,
  decodeIdentity,
  decodeMeterDetail,
  type TaggedReply,
} from "./fields.js";
import { unhex } from "./bytes.js";

// Every fixture below is a real reply captured from an ADO Air 20Pro (byte-identical across
// multiple separate hardware sessions where noted) — see reverse-engineering.md §10.
const reply = (offset: number, hex: string): TaggedReply => ({ offset, data: unhex(hex) });

describe("decodeIdentity", () => {
  it("decodes hardware/firmware/model from the offset-0 header reply", () => {
    // Real 0xA3 hardware/firmware version bytes, padded to 60 bytes (model left blank/empty).
    const header = reply(
      0,
      "435220413130312e4320312e310000000000000000000000" +
        "4352533230524333363135463830313032362e3400000000" +
        "000000000000000000000000",
    );
    const identity = decodeIdentity(header, undefined, undefined);
    expect(identity.hardwareVersion).toBe("CR A101.C 1.1");
    expect(identity.firmwareVersion).toBe("CRS20RC3615F801026.4");
    expect(identity.model).toBe("");
  });

  it("decodes the meter's serial number from its offset-72 reply", () => {
    const serial = reply(72, "3933383531333836344e30303635310000000000000000000000000000000000");
    const identity = decodeIdentity(
      reply(0, "00".repeat(72)),
      serial,
      undefined,
    );
    expect(identity.serialNumber).toBe("938513864N00651");
  });

  it("decodes the meter's manufacturer from its offset-120 reply at the corrected offset", () => {
    // Byte-identical across ado-protocol-test-9/-13/-14.json. Documented as offset 128 in the
    // spec; bytes 120-135 are actually zero and "ADO-EBIKE" starts at 136 — see the caveat in
    // docs/ado-ble-protocol.md §14.
    const manufacturer = reply(
      120,
      "0000000000000000000000000000000041444f2d4542494b4500000000000000",
    );
    const identity = decodeIdentity(reply(0, "00".repeat(72)), undefined, manufacturer);
    expect(identity.manufacturer).toBe("ADO-EBIKE");
  });

  it("returns empty strings when nothing was read", () => {
    const identity = decodeIdentity(reply(0, ""), undefined, undefined);
    expect(identity).toEqual({
      hardwareVersion: "",
      firmwareVersion: "",
      model: "",
      serialNumber: "",
      manufacturer: "",
    });
  });
});

describe("decodeControllerDetail", () => {
  it("decodes a real live-block reply (offset 160)", () => {
    const live = reply(160, "640000000000ffff0000ee00000000002210140014000000");
    const detail = decodeControllerDetail(live, undefined, undefined);
    expect(detail.batteryPercent).toBe(100);
    expect(detail.remainingRangeKm).toBeUndefined(); // 0xFFFF sentinel
    expect(detail.torqueSignalMv).toBe(238);
    expect(detail.batteryVoltageV).toBeCloseTo(41.3);
    expect(detail.controllerTemperatureC).toBe(20);
    expect(detail.motorTemperatureC).toBe(20);
    expect(detail.boostActive).toBe(false);
    expect(detail.computedPowerW).toBe(0); // motor current is 0 while stationary
  });

  it("decodes a real config reply (offset 168) for speed limit / wheel diameter", () => {
    const config = reply(168, "0000ee00000000002210140014000000c409c8003b060000");
    const detail = decodeControllerDetail(undefined, config, undefined);
    expect(detail.speedLimitKmh).toBeCloseTo(25.0);
    expect(detail.wheelDiameterInches).toBe(20); // raw 200, x0.1in -> confirmed 20in on this bike
    expect(detail.tyreCircumferenceMm).toBe(1595);
  });

  it("computes power in watts from voltage and current, both already in real units", () => {
    // offset 174 (motor current, raw 500 -> 5.00A) and offset 176 (battery voltage, raw 4000 -> 40.00V).
    const live = reply(160, "0000000000000000000000000000f401a00f000000000000");
    const detail = decodeControllerDetail(live, undefined, undefined);
    expect(detail.motorCurrentA).toBeCloseTo(5.0);
    expect(detail.batteryVoltageV).toBeCloseTo(40.0);
    expect(detail.computedPowerW).toBeCloseTo(200.0); // 5.00A * 40.00V, not /100 again
  });

  it("falls back to zero when nothing was read at all", () => {
    const detail = decodeControllerDetail(undefined, undefined, undefined);
    expect(detail.batteryPercent).toBe(0);
    expect(detail.boostActive).toBe(false);
    expect(detail.remainingRangeKm).toBeUndefined();
  });
});

describe("decodeBatteryDetail", () => {
  it("decodes a real offset-144 reply, applying the x0.1V pack-voltage scaling", () => {
    const detail = reply(144, "000000000000000000009c01000000000000000000000000");
    const battery = decodeBatteryDetail(detail, undefined);
    // Confirmed twice against the controller's independent voltage reading (reverse-engineering.md §10).
    expect(battery.packVoltageV).toBeCloseTo(41.2);
    expect(battery.cellsInSeries).toBe(0);
  });
});

describe("decodeMeterDetail", () => {
  it("decodes the real assist-level/sport-mode/backlight replies", () => {
    const meter = decodeMeterDetail(
      reply(160, "0500"),
      reply(162, "0001"),
      reply(166, "0300"),
      undefined,
    );
    expect(meter.assistLevelCount).toBe(5);
    expect(meter.sportMode).toBe(0);
    expect(meter.backlightLevel).toBe(3);
  });
});
