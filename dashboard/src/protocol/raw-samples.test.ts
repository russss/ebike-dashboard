import { describe, expect, it } from "vitest";
import {
  extractDeviceTableRawSamples,
  extractLiveBroadcastRawSamples,
  extractTripBroadcastRawSamples,
} from "./raw-samples.js";
import { decodeLiveStatus, decodeTripStats } from "./decode.js";
import { unhex } from "./bytes.js";
import { ADDR_BATTERY, ADDR_CONTROLLER, ADDR_METER, ADDR_SENSOR } from "./constants.js";

function sampleMap(samples: { variable: string; value: number }[]): Map<string, number> {
  return new Map(samples.map((s) => [s.variable, s.value]));
}

describe("extractDeviceTableRawSamples", () => {
  it("extracts pre-scaling integers from a real controller live-block reply (offset 160)", () => {
    // Same fixture as fields.test.ts's "decodes a real live-block reply" — decoded there as
    // torqueSignalMv 238, batteryVoltageV 41.3, controllerTemperatureC 20.
    const data = unhex("640000000000ffff0000ee00000000002210140014000000");
    const samples = extractDeviceTableRawSamples(ADDR_CONTROLLER, 160, data, 1000);
    const values = sampleMap(samples);

    expect(values.get("controller.batteryPercent")).toBe(100);
    expect(values.get("controller.remainingRangeKm")).toBe(0xffff); // the sentinel, un-interpreted
    expect(values.get("controller.torqueSignalMv")).toBe(238); // u16 decode -> raw === decoded
    expect(values.get("controller.batteryVoltageV")).toBe(4130); // decoded 41.30 = raw / 100
    expect(values.get("controller.controllerTemperatureC")).toBe(20);
    expect(samples.every((s) => s.timestamp === 1000)).toBe(true);
  });

  it("extracts nothing from an identity read — no field table covers offsets 0-143", () => {
    const header = unhex("00".repeat(60));
    expect(extractDeviceTableRawSamples(ADDR_CONTROLLER, 0, header, 1000)).toEqual([]);
    const serial = unhex("00".repeat(24));
    expect(extractDeviceTableRawSamples(ADDR_METER, 72, serial, 1000)).toEqual([]);
  });

  it("uses a signed read for battery pack current, the one signed field", () => {
    // Raw two's-complement -150 (0xFF6A little-endian) at offset 152 -> -1.50A once scaled.
    const data = new Uint8Array(24);
    data[152 - 144] = 0x6a;
    data[152 - 144 + 1] = 0xff;
    const samples = extractDeviceTableRawSamples(ADDR_BATTERY, 144, data, 1000);
    expect(sampleMap(samples).get("battery.packCurrentA")).toBe(-150);
  });

  it("decodes a real battery reply (offset 144), matching fields.test.ts's pack voltage case", () => {
    const data = unhex("000000000000000000009c01000000000000000000000000");
    const samples = extractDeviceTableRawSamples(ADDR_BATTERY, 144, data, 1000);
    expect(sampleMap(samples).get("battery.packVoltageV")).toBe(412); // decoded 41.2 = raw / 10
  });

  it("decodes a real meter reply, matching fields.test.ts's assist-level-count case", () => {
    const samples = extractDeviceTableRawSamples(ADDR_METER, 160, unhex("0500"), 1000);
    expect(sampleMap(samples).get("meter.assistLevelCount")).toBe(5);
  });

  it("yields nothing for a node with no raw field table (0xA7)", () => {
    expect(extractDeviceTableRawSamples(ADDR_SENSOR, 0, unhex("00".repeat(60)), 1000)).toEqual([]);
  });
});

describe("raw broadcast extraction — cross-checked against the real decoders", () => {
  const LIVE_HEX = "000000010000056400000000000000000000000000";
  const TRIP_HEX = "0000000000000000c800c4090300000500000000";

  it("extractLiveBroadcastRawSamples agrees with decodeLiveStatus on the same fixture", () => {
    const data = unhex(LIVE_HEX);
    const decoded = decodeLiveStatus(data);
    const raw = sampleMap(extractLiveBroadcastRawSamples(data, 1000));

    expect(raw.get("live.assistLevels")).toBe(decoded.assistLevels);
    expect(raw.get("live.batteryMainByte")).toBe(100); // decoded.batteryMain.percentage is 100
    expect(raw.get("live.speedKmh")).toBe(Math.round(decoded.speedKmh * 10));
    expect(raw.get("live.tripKm")).toBe(Math.round(decoded.tripKm * 100));
    expect(raw.get("live.odometerKm")).toBe(Math.round(decoded.odometerKm * 100));
    expect(raw.get("live.calories")).toBe(decoded.calories);
  });

  it("extractTripBroadcastRawSamples agrees with decodeTripStats on the same fixture", () => {
    const data = unhex(TRIP_HEX);
    const decoded = decodeTripStats(data);
    const raw = sampleMap(extractTripBroadcastRawSamples(data, 1000));

    expect(raw.get("trip.durationS")).toBe(decoded.durationS);
    expect(raw.get("trip.avgSpeedKmh")).toBe(Math.round(decoded.avgSpeedKmh * 100));
    expect(raw.get("trip.maxSpeedKmh")).toBe(Math.round(decoded.maxSpeedKmh * 10));
    expect(raw.get("trip.backlightLevel")).toBe(decoded.backlightLevel);
    expect(raw.get("trip.totalRideS")).toBe(decoded.totalRideS);
  });
});
