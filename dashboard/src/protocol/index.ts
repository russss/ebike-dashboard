/**
 * Public surface of the ADO e-bike protocol module. Deliberately does not re-export
 * `transport.ts` or anything taking a raw offset/length — {@link AdoBike} is the only supported
 * entry point, and its own surface never accepts an arbitrary register read.
 */
export { AdoBike } from "./bike.js";
export { UnsafeRegisterReadError } from "./safety.js";
export type { BikeProfile, UnavailableBatteryField } from "./profiles.js";
export type { RawSample } from "./raw-samples.js";
export type {
  BatteryDetail,
  BikeDetail,
  ConnectionState,
  ControllerDetail,
  Identity,
  LiveStatus,
  MeterDetail,
  ModuleIdentities,
  TripStats,
} from "./types.js";
