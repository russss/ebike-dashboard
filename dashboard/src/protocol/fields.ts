/**
 * Declarative field tables for the four device tables (0xA3/0xA4/0xA5/0xA7), restricted to
 * exactly the confirmed-safe offsets this dashboard ever reads — see bike.ts for the fixed list
 * of requests these are decoded from, and reverse-engineering.md §10 for how each was validated.
 */
import { asciiString, leInt, leUint } from "./bytes.js";
import { readField, type Field } from "./decode.js";
import type { BatteryDetail, ControllerDetail, Identity, MeterDetail } from "./types.js";

/** One reply buffer, tagged with the absolute offset its first byte corresponds to. */
export interface TaggedReply {
  readonly offset: number;
  readonly data: Uint8Array;
}

const u16 = (bytes: Uint8Array) => leUint(bytes);
const scaled10 = (bytes: Uint8Array) => leUint(bytes) / 10;
const scaled100 = (bytes: Uint8Array) => leUint(bytes) / 100;

// --- identity header (offsets 0-143), shared shape across 0xA3/0xA4/0xA5 -------------------

const HARDWARE_VERSION_OFFSET = 0;
const FIRMWARE_VERSION_OFFSET = 24;
const MODEL_OFFSET = 48;
const SERIAL_NUMBER_OFFSET = 72;
// Documented as 128 in the spec, but three separate hardware captures show the ASCII string
// actually starts at 136 (bytes 128-135 read zero) — see the caveat in docs/ado-ble-protocol.md
// §14's identity header table.
const MANUFACTURER_OFFSET = 136;

/**
 * Identity strings are NUL-terminated ASCII, always much shorter than their nominal field
 * width — unlike numeric fields, a reply that's shorter than the full declared width still
 * fully captures the string, so this clips to whatever's actually available rather than
 * requiring the whole field (readField's strict size check would reject every real reply here).
 */
function readAsciiField(offset: number, maxSize: number, reply: TaggedReply): string | undefined {
  const index = offset - reply.offset;
  if (index < 0 || index >= reply.data.length) return undefined;
  const available = Math.min(maxSize, reply.data.length - index);
  return asciiString(reply.data.subarray(index, index + available));
}

/**
 * Binds `readField` to one possibly-missing reply, so decode functions below can write
 * `read(SOME_FIELD)` instead of repeating `reply && readField(field, reply.offset, reply.data)`
 * for every field they pull out of the same reply.
 */
function bindReader(reply: TaggedReply | undefined) {
  return <T>(field: Field<T>): T | undefined =>
    reply && readField(field, reply.offset, reply.data);
}

/**
 * Assembles a node's identity from its two fixed reads: offset 0 (rounds up to ~72 bytes,
 * covers hardware/firmware/model) and offset 72 (serial number). `manufacturer` only ever
 * comes back on the meter, via its offset-120 read — see decodeMeterIdentity.
 */
export function decodeIdentity(
  header: TaggedReply,
  serial: TaggedReply | undefined,
  manufacturer: TaggedReply | undefined,
): Identity {
  return {
    hardwareVersion: readAsciiField(HARDWARE_VERSION_OFFSET, 24, header) ?? "",
    firmwareVersion: readAsciiField(FIRMWARE_VERSION_OFFSET, 24, header) ?? "",
    model: readAsciiField(MODEL_OFFSET, 24, header) ?? "",
    serialNumber: (serial && readAsciiField(SERIAL_NUMBER_OFFSET, 40, serial)) ?? "",
    manufacturer: (manufacturer && readAsciiField(MANUFACTURER_OFFSET, 16, manufacturer)) ?? "",
  };
}

// --- controller (0xA3) live block + config --------------------------------------------------

export const CONTROLLER_LIVE_FIELDS = {
  batteryPercent: { offset: 160, size: 2, decode: u16 } satisfies Field<number>,
  tripKm: { offset: 162, size: 2, decode: scaled100 } satisfies Field<number>,
  odometerKm: { offset: 164, size: 2, decode: scaled100 } satisfies Field<number>,
  remainingRangeKm: {
    offset: 166,
    size: 2,
    decode: (b) => {
      const raw = leUint(b);
      return raw === 0xffff ? undefined : raw / 100;
    },
  } satisfies Field<number | undefined>,
  cadenceRpm: { offset: 168, size: 2, decode: u16 } satisfies Field<number>,
  torqueSignalMv: { offset: 170, size: 2, decode: u16 } satisfies Field<number>,
  speedKmh: { offset: 172, size: 2, decode: scaled100 } satisfies Field<number>,
  motorCurrentA: { offset: 174, size: 2, decode: scaled100 } satisfies Field<number>,
  batteryVoltageV: { offset: 176, size: 2, decode: scaled100 } satisfies Field<number>,
  // Taken directly as °C — see the ControllerDetail JSDoc for why the documented "-40" scaling
  // isn't applied here.
  controllerTemperatureC: { offset: 178, size: 2, decode: u16 } satisfies Field<number>,
  motorTemperatureC: { offset: 180, size: 2, decode: u16 } satisfies Field<number>,
  boostActive: { offset: 182, size: 2, decode: (b) => leUint(b) !== 0 } satisfies Field<boolean>,
};

export const CONTROLLER_CONFIG_FIELDS = {
  speedLimitKmh: { offset: 184, size: 2, decode: scaled100 } satisfies Field<number>,
  wheelDiameterInches: { offset: 186, size: 2, decode: scaled10 } satisfies Field<number>,
  tyreCircumferenceMm: { offset: 188, size: 2, decode: u16 } satisfies Field<number>,
  calories: { offset: 190, size: 2, decode: u16 } satisfies Field<number>,
};

export const WHEEL_SPEED_FIELD = { offset: 196, size: 2, decode: u16 } satisfies Field<number>;

/**
 * `live` = offset-160 reply, `config` = offset-168 reply, `wheelSpeed` = offset-196 reply.
 * Missing fields (a reply that didn't arrive) fall back to 0 — the UI treats 0 as "no data yet"
 * via connection state, not as a real reading of zero.
 */
export function decodeControllerDetail(
  live: TaggedReply | undefined,
  config: TaggedReply | undefined,
  wheelSpeed: TaggedReply | undefined,
): ControllerDetail {
  const readLive = bindReader(live);
  const readConfig = bindReader(config);
  const readWheelSpeed = bindReader(wheelSpeed);

  const voltage = readLive(CONTROLLER_LIVE_FIELDS.batteryVoltageV) ?? 0;
  const current = readLive(CONTROLLER_LIVE_FIELDS.motorCurrentA) ?? 0;

  return {
    batteryPercent: readLive(CONTROLLER_LIVE_FIELDS.batteryPercent) ?? 0,
    tripKm: readLive(CONTROLLER_LIVE_FIELDS.tripKm) ?? 0,
    odometerKm: readLive(CONTROLLER_LIVE_FIELDS.odometerKm) ?? 0,
    remainingRangeKm: readLive(CONTROLLER_LIVE_FIELDS.remainingRangeKm),
    cadenceRpm: readLive(CONTROLLER_LIVE_FIELDS.cadenceRpm) ?? 0,
    torqueSignalMv: readLive(CONTROLLER_LIVE_FIELDS.torqueSignalMv) ?? 0,
    speedKmh: readLive(CONTROLLER_LIVE_FIELDS.speedKmh) ?? 0,
    motorCurrentA: current,
    batteryVoltageV: voltage,
    controllerTemperatureC: readLive(CONTROLLER_LIVE_FIELDS.controllerTemperatureC) ?? 0,
    motorTemperatureC: readLive(CONTROLLER_LIVE_FIELDS.motorTemperatureC) ?? 0,
    boostActive: readLive(CONTROLLER_LIVE_FIELDS.boostActive) ?? false,
    speedLimitKmh: readConfig(CONTROLLER_CONFIG_FIELDS.speedLimitKmh) ?? 0,
    wheelDiameterInches: readConfig(CONTROLLER_CONFIG_FIELDS.wheelDiameterInches) ?? 0,
    tyreCircumferenceMm: readConfig(CONTROLLER_CONFIG_FIELDS.tyreCircumferenceMm) ?? 0,
    calories: readConfig(CONTROLLER_CONFIG_FIELDS.calories) ?? 0,
    wheelSpeedRpm: readWheelSpeed(WHEEL_SPEED_FIELD) ?? 0,
    // `voltage` and `current` are already scaled to real volts/amps, so this is a plain V*A --
    // no further division needed (unlike the raw x raw / 10000 form used when working from
    // unscaled register values directly).
    computedPowerW: voltage * current,
  };
}

// --- battery (0xA4) detail -------------------------------------------------------------------

export const BATTERY_FIELDS = {
  fullCapacityMah: { offset: 144, size: 2, decode: u16 } satisfies Field<number>,
  remainingCapacityMah: { offset: 146, size: 2, decode: u16 } satisfies Field<number>,
  chargeOfFullPercent: { offset: 148, size: 2, decode: u16 } satisfies Field<number>,
  chargeOfDesignPercent: { offset: 150, size: 2, decode: u16 } satisfies Field<number>,
  packCurrentA: { offset: 152, size: 2, decode: (b) => leInt(b) / 100 } satisfies Field<number>,
  // Documented as x0.01V, but confirmed twice (see reverse-engineering.md §10) that x0.1V is
  // what actually matches the controller's own, independently-read voltage.
  packVoltageV: { offset: 154, size: 2, decode: (b) => leUint(b) / 10 } satisfies Field<number>,
  // Taken directly as °C, same reasoning as the controller/motor temperature fields — a real
  // reading of raw 0 is a plausible "unpopulated," but -40°C (the documented scaling) is not a
  // plausible pack temperature. See the ControllerDetail JSDoc in types.ts.
  packTemperatureC: { offset: 156, size: 2, decode: u16 } satisfies Field<number>,
  heaterActive: { offset: 158, size: 1, decode: (b) => (b[0] ?? 0) !== 0 } satisfies Field<boolean>,
  charging: { offset: 159, size: 1, decode: (b) => (b[0] ?? 0) !== 0 } satisfies Field<boolean>,
  discharging: { offset: 160, size: 1, decode: (b) => (b[0] ?? 0) !== 0 } satisfies Field<boolean>,
  cellsInSeries: { offset: 162, size: 1, decode: (b) => b[0] ?? 0 } satisfies Field<number>,
  cellsInParallel: { offset: 163, size: 1, decode: (b) => b[0] ?? 0 } satisfies Field<number>,
};

export const MAX_CHARGE_VOLTAGE_FIELD = { offset: 236, size: 4, decode: scaled100 } satisfies Field<number>;
export const MAX_CHARGE_CURRENT_FIELD = { offset: 240, size: 4, decode: scaled100 } satisfies Field<number>;

/** `detail` = offset-144 reply, `maxCharge` = offset-236 reply (covers both 236 and 240). */
export function decodeBatteryDetail(
  detail: TaggedReply | undefined,
  maxCharge: TaggedReply | undefined,
): BatteryDetail {
  const read = bindReader(detail);
  const readCharge = bindReader(maxCharge);

  return {
    fullCapacityMah: read(BATTERY_FIELDS.fullCapacityMah) ?? 0,
    remainingCapacityMah: read(BATTERY_FIELDS.remainingCapacityMah) ?? 0,
    chargeOfFullPercent: read(BATTERY_FIELDS.chargeOfFullPercent) ?? 0,
    chargeOfDesignPercent: read(BATTERY_FIELDS.chargeOfDesignPercent) ?? 0,
    packCurrentA: read(BATTERY_FIELDS.packCurrentA) ?? 0,
    packVoltageV: read(BATTERY_FIELDS.packVoltageV) ?? 0,
    packTemperatureC: read(BATTERY_FIELDS.packTemperatureC) ?? 0,
    heaterActive: read(BATTERY_FIELDS.heaterActive) ?? false,
    charging: read(BATTERY_FIELDS.charging) ?? false,
    discharging: read(BATTERY_FIELDS.discharging) ?? false,
    cellsInSeries: read(BATTERY_FIELDS.cellsInSeries) ?? 0,
    cellsInParallel: read(BATTERY_FIELDS.cellsInParallel) ?? 0,
    maxChargeVoltageV: readCharge(MAX_CHARGE_VOLTAGE_FIELD) ?? 0,
    maxChargeCurrentA: readCharge(MAX_CHARGE_CURRENT_FIELD) ?? 0,
  };
}

// --- meter/display (0xA5) detail --------------------------------------------------------------

export const METER_HEADER_FIELDS = {
  assistLevelCount: { offset: 160, size: 2, decode: u16 } satisfies Field<number>,
  sportMode: { offset: 162, size: 1, decode: (b) => b[0] ?? 0 } satisfies Field<number>,
  backlightLevel: { offset: 166, size: 2, decode: u16 } satisfies Field<number>,
};

export const METER_TRIP_FIELDS = {
  tripKm: { offset: 168, size: 2, decode: u16 } satisfies Field<number>,
  distanceSinceServiceKm: { offset: 176, size: 4, decode: u16 } satisfies Field<number>,
  autoOffTimeMin: { offset: 180, size: 2, decode: u16 } satisfies Field<number>,
  totalRideTimeMin: { offset: 186, size: 4, decode: u16 } satisfies Field<number>,
  totalCalories: { offset: 190, size: 4, decode: u16 } satisfies Field<number>,
};

/**
 * `header` = offset-160/162/166 replies (small, so decoded independently rather than
 * assuming they share one buffer), `trip` = offset-168 reply.
 */
export function decodeMeterDetail(
  assistLevels: TaggedReply | undefined,
  sportMode: TaggedReply | undefined,
  backlight: TaggedReply | undefined,
  trip: TaggedReply | undefined,
): MeterDetail {
  const readAssistLevels = bindReader(assistLevels);
  const readSportMode = bindReader(sportMode);
  const readBacklight = bindReader(backlight);
  const readTrip = bindReader(trip);

  return {
    assistLevelCount: readAssistLevels(METER_HEADER_FIELDS.assistLevelCount) ?? 0,
    sportMode: readSportMode(METER_HEADER_FIELDS.sportMode) ?? 0,
    backlightLevel: readBacklight(METER_HEADER_FIELDS.backlightLevel) ?? 0,
    tripKm: readTrip(METER_TRIP_FIELDS.tripKm) ?? 0,
    distanceSinceServiceKm: readTrip(METER_TRIP_FIELDS.distanceSinceServiceKm) ?? 0,
    autoOffTimeMin: readTrip(METER_TRIP_FIELDS.autoOffTimeMin) ?? 0,
    totalRideTimeMin: readTrip(METER_TRIP_FIELDS.totalRideTimeMin) ?? 0,
    totalCalories: readTrip(METER_TRIP_FIELDS.totalCalories) ?? 0,
  };
}
