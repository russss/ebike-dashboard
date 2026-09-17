/**
 * Generic field-reading engine, plus the two status-broadcast decoders (fixed-layout structs,
 * not table fields — see fields.ts for the per-node device tables that build on `readField`).
 */
import { batteryByte, leUint } from "./bytes.js";
import type { LiveStatus, TripStats } from "./types.js";

/** Describes one value at an absolute byte offset within a device table. */
export interface Field<T> {
  readonly offset: number;
  readonly size: number;
  readonly decode: (bytes: Uint8Array) => T;
}

/**
 * Reads `field` out of `buffer`, given that `buffer[0]` corresponds to absolute offset
 * `bufferStartOffset` in the table (a reply's SUB echoes the offset it was asked for, but a
 * single buffer may combine several fields read together). Returns `undefined` if the field
 * isn't fully covered by what's actually in `buffer` — never assumes more than was received.
 */
export function readField<T>(
  field: Field<T>,
  bufferStartOffset: number,
  buffer: Uint8Array,
): T | undefined {
  const index = field.offset - bufferStartOffset;
  if (index < 0 || index + field.size > buffer.length) return undefined;
  return field.decode(buffer.subarray(index, index + field.size));
}

// §7, group SUB=0x01 — pushed unprompted every ~250ms once authenticated.
export function decodeLiveStatus(data: Uint8Array): LiveStatus {
  return {
    faultCode: data[0] ?? 0,
    batterySecondary: batteryByte(data[1] ?? 0),
    batteryMain: batteryByte(data[7] ?? 0),
    activeBattery: ((data[2] ?? 0) >> 2) & 0x03,
    headlightOn: (data[4] ?? 0) !== 0,
    assistLevel: data[5] ?? 0,
    assistLevels: data[6] ?? 0,
    workingMode: data[8] ?? 0,
    speedKmh: leUint(data.subarray(9, 11)) / 10,
    tripKm: leUint(data.subarray(11, 15)) / 100,
    odometerKm: leUint(data.subarray(15, 19)) / 100,
    calories: leUint(data.subarray(19, 21)),
  };
}

// §7, group SUB=0x09.
export function decodeTripStats(data: Uint8Array): TripStats {
  return {
    durationS: leUint(data.subarray(0, 4)),
    avgSpeedKmh: leUint(data.subarray(4, 6)) / 100,
    maxSpeedKmh: leUint(data.subarray(6, 8)) / 10,
    backlightLevel: data[12] ?? 0, // plain level; the app's own nibble split is a bug, not this
    unitMiles: (data[13] ?? 0) !== 0,
    totalRideS: leUint(data.subarray(16, 20)),
  };
}
