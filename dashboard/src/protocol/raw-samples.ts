/**
 * Captures every decoded field's *pre-scaling* value, tagged with the timestamp the frame that
 * carried it was received — the raw material for a full-resolution time-series history, as
 * opposed to `LiveStatus`/`ControllerDetail`/etc., which only ever hold the latest scaled
 * snapshot. This exists because this whole project's history is full of scaling assumptions
 * that turned out wrong (temperature, wheel diameter, pack voltage — see
 * reverse-engineering.md §10-§11): storing the raw integer means a session recorded today can
 * still be correctly reinterpreted if a scaling assumption changes tomorrow.
 *
 * Deliberately reuses the offset/size already declared once in `fields.ts` — never re-states an
 * offset here, since a second copy is exactly how these tables would drift apart. The one thing
 * not derivable from `fields.ts` is signedness (`Field<T>.decode` is an opaque closure), so
 * `SIGNED_VARIABLES` names the one field that needs `leInt` instead of the default `leUint`.
 *
 * Identity fields (offsets 0-143 — hardware/firmware version, model, serial, manufacturer) are
 * deliberately excluded: they're ASCII strings read once at connect, not numeric telemetry, and
 * have no meaningful "history". Nothing here defines raw descriptors for those offsets.
 */
import { leInt, leUint } from "./bytes.js";
import { ADDR_BATTERY, ADDR_CONTROLLER, ADDR_METER } from "./constants.js";
import {
  BATTERY_FIELDS,
  CONTROLLER_CONFIG_FIELDS,
  CONTROLLER_LIVE_FIELDS,
  MAX_CHARGE_CURRENT_FIELD,
  MAX_CHARGE_VOLTAGE_FIELD,
  METER_HEADER_FIELDS,
  METER_TRIP_FIELDS,
  WHEEL_SPEED_FIELD,
} from "./fields.js";

/** One field's raw (unscaled) reading at the moment its frame arrived. */
export interface RawSample {
  /** `"<source>.<fieldName>"`, e.g. `"controller.speedKmh"`, `"live.assistLevel"` — matches the
   *  scaled field's own name in `LiveStatus`/`ControllerDetail`/etc. wherever one exists. */
  readonly variable: string;
  /** `Date.now()`-style epoch milliseconds, taken from the frame that carried this value. */
  readonly timestamp: number;
  /** The value exactly as decoded by `leUint`/`leInt`, before any scaling/sign/boolean logic. */
  readonly value: number;
}

interface RawFieldSpec {
  readonly offset: number;
  readonly size: number;
}

const SIGNED_VARIABLES = new Set<string>(["battery.packCurrentA"]);

function extractRawSamples(
  prefix: string,
  fields: Readonly<Record<string, RawFieldSpec>>,
  bufferStartOffset: number,
  buffer: Uint8Array,
  timestamp: number,
): RawSample[] {
  const samples: RawSample[] = [];
  for (const [name, field] of Object.entries(fields)) {
    const index = field.offset - bufferStartOffset;
    if (index < 0 || index + field.size > buffer.length) continue;
    const variable = `${prefix}.${name}`;
    const bytes = buffer.subarray(index, index + field.size);
    const value = SIGNED_VARIABLES.has(variable) ? leInt(bytes) : leUint(bytes);
    samples.push({ variable, timestamp, value });
  }
  return samples;
}

const CONTROLLER_RAW_FIELDS: Readonly<Record<string, RawFieldSpec>> = {
  ...CONTROLLER_LIVE_FIELDS,
  ...CONTROLLER_CONFIG_FIELDS,
  wheelSpeedRpm: WHEEL_SPEED_FIELD,
};

const BATTERY_RAW_FIELDS: Readonly<Record<string, RawFieldSpec>> = {
  ...BATTERY_FIELDS,
  maxChargeVoltageV: MAX_CHARGE_VOLTAGE_FIELD,
  maxChargeCurrentA: MAX_CHARGE_CURRENT_FIELD,
};

const METER_RAW_FIELDS: Readonly<Record<string, RawFieldSpec>> = {
  ...METER_HEADER_FIELDS,
  ...METER_TRIP_FIELDS,
};

/**
 * For a register-read reply (`frame.src` = node, `frame.sub` = the offset it was asked for,
 * `frame.data` = the reply bytes). Nodes with no raw field table (0xA7) — and identity reads on
 * any node, since none of their offsets fall inside these tables — always yield `[]`.
 */
export function extractDeviceTableRawSamples(
  node: number,
  offset: number,
  data: Uint8Array,
  timestamp: number,
): RawSample[] {
  switch (node) {
    case ADDR_CONTROLLER:
      return extractRawSamples("controller", CONTROLLER_RAW_FIELDS, offset, data, timestamp);
    case ADDR_BATTERY:
      return extractRawSamples("battery", BATTERY_RAW_FIELDS, offset, data, timestamp);
    case ADDR_METER:
      return extractRawSamples("meter", METER_RAW_FIELDS, offset, data, timestamp);
    default:
      return [];
  }
}

/**
 * Mirrors `decodeLiveStatus`'s byte layout (decode.ts, SUB=0x01) — kept in sync by
 * `raw-samples.test.ts`'s cross-check against that function, not by sharing code with it (its
 * offsets are hardcoded `data[n]`/`subarray()` calls, not a `Field` table, so there's nothing
 * here to derive from). Byte-packed values (battery/assist bytes) are captured as their whole
 * raw byte rather than pre-split into the several logical values decodeLiveStatus derives from
 * them — the bit-split is itself a conversion.
 */
const LIVE_BROADCAST_RAW_FIELDS: Readonly<Record<string, RawFieldSpec>> = {
  faultCode: { offset: 0, size: 1 },
  batterySecondaryByte: { offset: 1, size: 1 },
  statusByte: { offset: 2, size: 1 }, // activeBattery lives in bits 2-3 of this byte
  headlightOn: { offset: 4, size: 1 },
  assistLevel: { offset: 5, size: 1 },
  assistLevels: { offset: 6, size: 1 },
  batteryMainByte: { offset: 7, size: 1 },
  workingMode: { offset: 8, size: 1 },
  speedKmh: { offset: 9, size: 2 },
  tripKm: { offset: 11, size: 4 },
  odometerKm: { offset: 15, size: 4 },
  calories: { offset: 19, size: 2 },
};

/** Mirrors `decodeTripStats`'s byte layout (decode.ts, SUB=0x09) — see the note above. */
const TRIP_BROADCAST_RAW_FIELDS: Readonly<Record<string, RawFieldSpec>> = {
  durationS: { offset: 0, size: 4 },
  avgSpeedKmh: { offset: 4, size: 2 },
  maxSpeedKmh: { offset: 6, size: 2 },
  backlightLevel: { offset: 12, size: 1 },
  unitMiles: { offset: 13, size: 1 },
  totalRideS: { offset: 16, size: 4 },
};

export function extractLiveBroadcastRawSamples(data: Uint8Array, timestamp: number): RawSample[] {
  return extractRawSamples("live", LIVE_BROADCAST_RAW_FIELDS, 0, data, timestamp);
}

export function extractTripBroadcastRawSamples(data: Uint8Array, timestamp: number): RawSample[] {
  return extractRawSamples("trip", TRIP_BROADCAST_RAW_FIELDS, 0, data, timestamp);
}
