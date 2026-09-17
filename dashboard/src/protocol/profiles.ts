/**
 * Everything in `safety.ts` and `bike.ts`'s fixed read list up to this point was validated on
 * exactly one bike: an ADO Air 20Pro whose meter identifies itself as model `B02H`. Nothing here
 * guarantees another ADO model — different controller firmware, possibly a different register
 * layout entirely — shares the same dangerous ranges, or even the same safe ones.
 *
 * A `BikeProfile` is what's actually confirmed for one specific model, keyed by the meter's own
 * `model` identity string (see `fields.ts`'s `decodeIdentity`). `AdoBike` reads identity first
 * (offsets 0-143 only — the identity header has never shown any hazard on any node, unlike the
 * live-value regions this gates), then looks up a profile by model before attempting anything
 * else. An unrecognised model gets no further reads at all, not a guess based on this one.
 */
import type { ByteRange } from "./safety.js";

/**
 * A {@link BatteryDetail} field (or, for the combined "cells" tile, a stand-in key with no
 * direct field of its own) confirmed to never carry real data on a given model. The UI hides
 * these rather than showing a permanently-zero or otherwise-bogus reading as if it were live.
 */
export type UnavailableBatteryField =
  | "packTemperatureC"
  | "chargeOfFullPercent"
  | "chargeOfDesignPercent"
  | "fullCapacityMah"
  | "remainingCapacityMah"
  | "cells"
  | "maxChargeVoltageV"
  | "maxChargeCurrentA";

export interface BikeProfile {
  readonly modelId: string;
  readonly dangerousRanges: ReadonlyMap<number, readonly ByteRange[]>;
  /** Battery fields confirmed unavailable on this model — see {@link UnavailableBatteryField}. */
  readonly unavailableBatteryFields: ReadonlySet<UnavailableBatteryField>;
  /**
   * Whether `LiveStatus.batteryMain.online` (bit 7 of the live battery-status byte, documented
   * as an online/offline flag) can be trusted on this model. `false` means the UI never
   * surfaces it as a status indicator — showing "offline" next to a battery that's plainly
   * connected and reporting a real charge level is worse than showing nothing.
   */
  readonly batteryOnlineBitTrusted: boolean;
  /** Free-text elaboration on the above, for the info tab — not itself used for any logic. */
  readonly notes: string;
}

const B02H: BikeProfile = {
  modelId: "B02H",
  dangerousRanges: new Map([
    [0xa3, [[192, 196], [198, 208]] as const],
    [0xa5, [[164, 166]] as const],
  ]),
  unavailableBatteryFields: new Set<UnavailableBatteryField>([
    "packTemperatureC",
    "chargeOfFullPercent",
    "chargeOfDesignPercent",
    "fullCapacityMah",
    "remainingCapacityMah",
    "cells",
    "maxChargeVoltageV",
    "maxChargeCurrentA",
  ]),
  batteryOnlineBitTrusted: false,
  notes:
    "Battery (0xA4 offset 144): full/remaining capacity, charge %, cells in series/parallel, " +
    "and pack temperature are all confirmed non-functional on this hardware — the dashboard " +
    "hides them rather than show a reading that's never right. Only pack voltage and pack " +
    "current are real. Offsets 236/240 (max charge voltage/current) are hidden for the same " +
    "reason. The live battery status's 'online' bit is also unreliable — confirmed reading " +
    "offline on a battery that was fully connected and charged. See reverse-engineering.md " +
    "§10-§11 for the run history this is based on.",
};

/** Keyed by the meter's own `model` identity string (e.g. `"B02H"`). */
export const KNOWN_PROFILES: Readonly<Record<string, BikeProfile>> = {
  [B02H.modelId]: B02H,
};

export function findProfile(modelId: string): BikeProfile | undefined {
  return KNOWN_PROFILES[modelId];
}
