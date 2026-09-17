/**
 * Across 14 rounds of hardware testing, reading certain byte ranges on certain nodes locks up
 * the bike's shared internal bus: status broadcasts stop, the BLE connection drops a few
 * seconds later, and recovery needs a power-cycle. See reverse-engineering.md §10 for the full
 * history — this boundary was revised upward four times as new crashes were found, and is not
 * guaranteed to be the last word, and was only ever confirmed on one specific bike model — see
 * `profiles.ts`.
 *
 * This is the single source of truth for the *mechanism* — every read this module ever sends
 * goes through `assertReadIsSafe` first (see bike.ts) — but the actual dangerous ranges are
 * per-model data owned by `profiles.ts`, passed in explicitly rather than hardcoded here, since
 * what's dangerous on one bike model is not known to apply to another.
 */

export type ByteRange = readonly [start: number, end: number];

export class UnsafeRegisterReadError extends Error {
  readonly node: number;
  readonly offset: number;
  readonly length: number;
  readonly range: ByteRange;

  constructor(node: number, offset: number, length: number, range: ByteRange) {
    super(
      `refusing to read node 0x${node.toString(16)} offset ${offset} length ${length}: ` +
        `overlaps the confirmed-dangerous range [${range[0]}, ${range[1]}) — see reverse-engineering.md §10`,
    );
    this.name = "UnsafeRegisterReadError";
    this.node = node;
    this.offset = offset;
    this.length = length;
    this.range = range;
  }
}

export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Throws {@link UnsafeRegisterReadError} if `[offset, offset + length)` overlaps a range in
 * `dangerousRanges` for `node`. `dangerousRanges` is deliberately a required parameter, not a
 * module-level default — see `profiles.ts` for where a caller's ranges actually come from.
 */
export function assertReadIsSafe(
  node: number,
  offset: number,
  length: number,
  dangerousRanges: ReadonlyMap<number, readonly ByteRange[]>,
): void {
  const ranges = dangerousRanges.get(node);
  if (!ranges) return;
  const hit = ranges.find(([start, end]) => rangesOverlap(offset, offset + length, start, end));
  if (hit) throw new UnsafeRegisterReadError(node, offset, length, hit);
}

/**
 * A benign "no reply" (an offset that isn't a real field) is followed by normal status
 * broadcasts continuing on schedule. A bus lockup is followed by *total* silence — no
 * broadcasts either — which is the one signal every confirmed crash in this project shares.
 * This threshold is roughly 5x the normal ~250-300ms broadcast spacing: wide enough to absorb
 * jitter, narrow enough to catch a lockup well before a per-request timeout would.
 */
export const LOCKUP_SUSPECTED_MS = 1500;

/** Tracks the timestamp of the most recently received frame, of any kind. */
export class LockupWatchdog {
  #lastFrameAt = 0;

  noteFrameReceived(now: number = Date.now()): void {
    this.#lastFrameAt = now;
  }

  /** `true` once at least one frame has ever been seen and it's been quiet for too long. */
  isLockupSuspected(now: number = Date.now()): boolean {
    if (this.#lastFrameAt === 0) return false;
    return now - this.#lastFrameAt > LOCKUP_SUSPECTED_MS;
  }
}
