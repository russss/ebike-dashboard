/** A fully parsed, checksum-verified frame. */
export interface Frame {
  readonly len: number;
  readonly src: number;
  readonly dst: number;
  readonly cmd: number;
  readonly sub: number;
  readonly data: Uint8Array;
  readonly crcOk: boolean;
}

/** Decoded live-status broadcast (SUB=0x01). */
export interface LiveStatus {
  readonly faultCode: number;
  readonly batterySecondary: { readonly percentage: number; readonly online: boolean };
  readonly batteryMain: { readonly percentage: number; readonly online: boolean };
  /** Which battery is actively discharging (0-3); meaning beyond that is unconfirmed. */
  readonly activeBattery: number;
  readonly headlightOn: boolean;
  readonly assistLevel: number;
  readonly assistLevels: number;
  readonly workingMode: number;
  readonly speedKmh: number;
  readonly tripKm: number;
  readonly odometerKm: number;
  readonly calories: number;
}

/** Decoded trip-stats broadcast (SUB=0x09). */
export interface TripStats {
  readonly durationS: number;
  readonly avgSpeedKmh: number;
  readonly maxSpeedKmh: number;
  readonly backlightLevel: number;
  readonly unitMiles: boolean;
  readonly totalRideS: number;
}

/** One node's identity header (offsets 0-143 of any device table), read once at connect. */
export interface Identity {
  readonly hardwareVersion: string;
  readonly firmwareVersion: string;
  readonly model: string;
  readonly serialNumber: string;
  readonly manufacturer: string;
}

/**
 * Identity for all four bus nodes, read once at connect. `sensor` (0xA7) has never answered
 * anything past offset 0 across many hardware sessions — its identity is included for
 * completeness and will simply read as all-empty strings, not because it's expected to have data.
 */
export interface ModuleIdentities {
  readonly controller: Identity;
  readonly battery: Identity;
  readonly meter: Identity;
  readonly sensor: Identity;
}

/** Controller (0xA3) live block + config, from offsets 160-191 and 196. */
export interface ControllerDetail {
  readonly batteryPercent: number;
  readonly tripKm: number;
  readonly odometerKm: number;
  readonly remainingRangeKm: number | undefined;
  readonly cadenceRpm: number;
  readonly torqueSignalMv: number;
  readonly speedKmh: number;
  readonly motorCurrentA: number;
  readonly batteryVoltageV: number;
  /**
   * The raw register value taken directly as °C, with no scaling applied. Spec §14 also
   * documents a "-40" scaling for this field, which would put a real sample at -20°C — not
   * plausible for a bike at rest, so this takes the unscaled reading as the working
   * assumption instead (see reverse-engineering.md §10).
   */
  readonly controllerTemperatureC: number;
  readonly motorTemperatureC: number;
  readonly boostActive: boolean;
  readonly speedLimitKmh: number;
  /**
   * Raw register x0.1in. Confirmed against a real bike: this model's wheel is 20in, and the
   * old webapp's settings-block parser (which applies the same x0.1 scale) showed exactly that.
   */
  readonly wheelDiameterInches: number;
  readonly tyreCircumferenceMm: number;
  readonly calories: number;
  /** Confirmed safe to read; has read 0 even while the wheel was turning — treat as unreliable. */
  readonly wheelSpeedRpm: number;
  readonly computedPowerW: number;
}

/** Battery (0xA4) detail, from offsets 144 and 236/240. */
export interface BatteryDetail {
  readonly fullCapacityMah: number;
  readonly remainingCapacityMah: number;
  readonly chargeOfFullPercent: number;
  readonly chargeOfDesignPercent: number;
  readonly packCurrentA: number;
  /**
   * Raw value x0.1V — confirmed twice against the controller's independently-read voltage, and
   * a third time against the pack's known chemistry (37V nominal / ~42V full-charge, a standard
   * 10S pack): every reading this dashboard produces lands in the low-to-mid 41V range, right
   * where that puts a mostly-to-fully-charged pack.
   */
  readonly packVoltageV: number;
  /**
   * Taken directly as °C, no scaling — see {@link ControllerDetail.controllerTemperatureC}. On
   * the one profiled bike model this is confirmed to never reflect a real reading regardless —
   * see `profiles.ts`'s `unavailableBatteryFields` — kept decoded here in case a future model's
   * profile finds it does work.
   */
  readonly packTemperatureC: number;
  readonly heaterActive: boolean;
  readonly charging: boolean;
  readonly discharging: boolean;
  readonly cellsInSeries: number;
  readonly cellsInParallel: number;
  readonly maxChargeVoltageV: number;
  readonly maxChargeCurrentA: number;
}

/** Meter/display (0xA5) detail, from offsets 160/162/166/168. */
export interface MeterDetail {
  readonly assistLevelCount: number;
  readonly sportMode: number;
  readonly backlightLevel: number;
  readonly tripKm: number;
  readonly distanceSinceServiceKm: number;
  readonly autoOffTimeMin: number;
  readonly totalRideTimeMin: number;
  readonly totalCalories: number;
}

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "ready"
  | "lockup-suspected"
  /**
   * Authenticated and identity read successfully, but the meter's `model` string doesn't match
   * any {@link BikeProfile} — see `profiles.ts`. Live-value telemetry stays unavailable rather
   * than reusing another model's confirmed-safe register list on hardware it's never been
   * tried on. Identity and the free status broadcasts still work, since neither touches a
   * per-model register.
   */
  | "unsupported-model";

/**
 * Always fully shaped — a field that couldn't be read falls back to a zero/false default rather
 * than the whole struct being absent. Compare against `AdoBike.connectionState` to tell "genuinely
 * zero" from "no data yet".
 */
export interface BikeDetail {
  readonly controller: ControllerDetail;
  readonly battery: BatteryDetail;
  readonly meter: MeterDetail;
}
