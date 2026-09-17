import { describe, expect, it } from "vitest";
import { decodeLiveStatus, decodeTripStats, readField } from "./decode.js";
import { unhex } from "./bytes.js";
import type { Field } from "./decode.js";

// Both fixtures below are real DATA fields captured from an ADO Air 20Pro at rest
// (ado-protocol-test-14.json), not synthetic — see reverse-engineering.md §10.
describe("decodeLiveStatus", () => {
  it("decodes a real idle-bike broadcast (SUB=0x01)", () => {
    const data = unhex("000000010000056400000000000000000000000000");
    const status = decodeLiveStatus(data);
    expect(status).toEqual({
      faultCode: 0,
      batterySecondary: { percentage: 0, online: false },
      batteryMain: { percentage: 100, online: false },
      activeBattery: 0,
      headlightOn: false,
      assistLevel: 0,
      assistLevels: 5,
      workingMode: 0,
      speedKmh: 0,
      tripKm: 0,
      odometerKm: 0,
      calories: 0,
    });
  });
});

describe("decodeTripStats", () => {
  it("decodes a real idle-bike broadcast (SUB=0x09)", () => {
    const data = unhex("0000000000000000c800c4090300000500000000");
    const stats = decodeTripStats(data);
    expect(stats).toEqual({
      durationS: 0,
      avgSpeedKmh: 0,
      maxSpeedKmh: 0,
      backlightLevel: 3,
      unitMiles: false,
      totalRideS: 0,
    });
  });
});

describe("readField", () => {
  const speed: Field<number> = { offset: 172, size: 2, decode: (b) => (b[0] ?? 0) + (b[1] ?? 0) * 256 };

  it("reads a field fully covered by the buffer", () => {
    const buf = unhex("640000000000ffff0000ee00000000002210140014000000"); // real 0xA3 offset-160 reply
    expect(readField(speed, 160, buf)).toBe(0);
  });

  it("returns undefined when the field isn't covered by a shorter buffer", () => {
    const buf = unhex("6400"); // only covers offset 160-161
    expect(readField(speed, 160, buf)).toBeUndefined();
  });

  it("returns undefined when the field starts before the buffer", () => {
    const buf = unhex("0000"); // covers offset 172-173, but we ask relative to 200
    expect(readField(speed, 200, buf)).toBeUndefined();
  });
});
