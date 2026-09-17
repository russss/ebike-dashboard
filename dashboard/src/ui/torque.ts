/**
 * The torque sensor is resistive: voltage falls as pedal force rises, with roughly 238mV
 * measured at rest (zero torque) and presumably ~0mV at maximum. The exact resting voltage isn't
 * a fixed spec constant, though — it's calibrated per session against the highest voltage
 * actually observed, rather than hardcoded, so it self-corrects if the true resting voltage
 * turns out to differ a little from that one measurement.
 */
export function torquePercent(rawMv: number, baselineMv: number): number {
  if (baselineMv <= 0) return 0;
  const percent = ((baselineMv - rawMv) / baselineMv) * 100;
  return Math.min(100, Math.max(0, percent));
}
