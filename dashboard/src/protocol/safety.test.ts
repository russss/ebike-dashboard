import { describe, expect, it, vi } from "vitest";
import {
  assertReadIsSafe,
  LockupWatchdog,
  LOCKUP_SUSPECTED_MS,
  UnsafeRegisterReadError,
} from "./safety.js";
import { ADDR_BATTERY, ADDR_CONTROLLER, ADDR_METER, ADDR_SENSOR } from "./constants.js";
import { KNOWN_PROFILES } from "./profiles.js";

// Every case here is a literal data point from reverse-engineering.md §10 — a real hardware
// incident or a real confirmed-safe read on the one bike model (B02H) this has ever been tested
// against, not a hypothesis and not assumed to generalise to any other model. Do not
// "simplify" this list.
const RANGES = KNOWN_PROFILES.B02H!.dangerousRanges;

describe("assertReadIsSafe — 0xA3 (motor controller)", () => {
  it.each([
    ["offset 200 exactly (seventh run)", 200, 24],
    ["offset 192, 24 bytes, overlapping into 200-201 (eighth run)", 192, 24],
    ["offset 202, chosen to start clear of the boundary as then understood (tenth run)", 202, 35],
    ["offset 192 alone, 2 bytes — too short to touch 200-201 (twelfth run)", 192, 2],
    ["offset 198 alone, 2 bytes (manual follow-up after the twelfth run)", 198, 2],
    ["offset 206, the far end of the range found by manual testing", 206, 2],
    ["a request that only partially overlaps the front of the range", 190, 4],
    ["a request that only partially overlaps the back of the range", 207, 4],
  ])("refuses %s", (_label, offset, length) => {
    expect(() => assertReadIsSafe(ADDR_CONTROLLER, offset, length, RANGES)).toThrow(
      UnsafeRegisterReadError,
    );
  });

  it.each([
    ["offset 168, 24 bytes, ending at 191 — confirmed fine", 168, 24],
    ["offset 196, 2 bytes — confirmed safe, sits between the two excluded ranges", 196, 2],
    ["offset 208 — requested and answered with silence, not a crash", 208, 29],
    ["offset 160, the live-value block start", 160, 24],
    ["offset 0, the identity header", 0, 60],
  ])("allows %s", (_label, offset, length) => {
    expect(() => assertReadIsSafe(ADDR_CONTROLLER, offset, length, RANGES)).not.toThrow();
  });

  it("has no evidence either way for offset 194, and treats it as unsafe rather than guessing", () => {
    // 194 sits between two confirmed-dangerous points (192 and 198) with no direct test of its
    // own. Excluding it is a deliberate choice, not an oversight — see the comment on the B02H
    // profile in profiles.ts for why it's folded into the 192-195 range rather than left open.
    expect(() => assertReadIsSafe(ADDR_CONTROLLER, 194, 2, RANGES)).toThrow(
      UnsafeRegisterReadError,
    );
  });
});

describe("assertReadIsSafe — 0xA5 (display/meter)", () => {
  it("refuses offset 164 — 'current assist level', crashed with a bare 2-byte request (thirteenth run)", () => {
    expect(() => assertReadIsSafe(ADDR_METER, 164, 2, RANGES)).toThrow(UnsafeRegisterReadError);
  });

  it.each([
    ["offset 163, immediately before the hazard", 163, 1],
    ["offset 166, immediately after the hazard", 166, 2],
    ["offset 160, the meter's live-value block start", 160, 2],
  ])("allows %s", (_label, offset, length) => {
    expect(() => assertReadIsSafe(ADDR_METER, offset, length, RANGES)).not.toThrow();
  });
});

describe("assertReadIsSafe — nodes with no confirmed hazard on this profile", () => {
  it("never crashed on 0xA4 or 0xA7, so nothing is excluded there yet", () => {
    expect(() => assertReadIsSafe(ADDR_BATTERY, 0, 244, RANGES)).not.toThrow();
    expect(() => assertReadIsSafe(ADDR_SENSOR, 0, 164, RANGES)).not.toThrow();
  });
});

describe("assertReadIsSafe — an empty ranges map blocks nothing", () => {
  it("is the caller's responsibility to pass real ranges, not a fallback this function invents", () => {
    const empty = new Map();
    expect(() => assertReadIsSafe(ADDR_CONTROLLER, 200, 24, empty)).not.toThrow();
  });
});

describe("UnsafeRegisterReadError", () => {
  it("reports which range it collided with", () => {
    try {
      assertReadIsSafe(ADDR_CONTROLLER, 192, 2, RANGES);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeRegisterReadError);
      const unsafe = error as UnsafeRegisterReadError;
      expect(unsafe.node).toBe(ADDR_CONTROLLER);
      expect(unsafe.range).toEqual([192, 196]);
    }
  });
});

describe("LockupWatchdog", () => {
  it("is not suspected before any frame has ever been seen", () => {
    const watchdog = new LockupWatchdog();
    expect(watchdog.isLockupSuspected()).toBe(false);
  });

  it("is not suspected shortly after a frame arrives", () => {
    vi.useFakeTimers();
    const watchdog = new LockupWatchdog();
    watchdog.noteFrameReceived();
    vi.advanceTimersByTime(LOCKUP_SUSPECTED_MS - 100);
    expect(watchdog.isLockupSuspected()).toBe(false);
    vi.useRealTimers();
  });

  it("is suspected once silence exceeds the threshold", () => {
    vi.useFakeTimers();
    const watchdog = new LockupWatchdog();
    watchdog.noteFrameReceived();
    vi.advanceTimersByTime(LOCKUP_SUSPECTED_MS + 1);
    expect(watchdog.isLockupSuspected()).toBe(true);
    vi.useRealTimers();
  });

  it("clears once a new frame arrives", () => {
    vi.useFakeTimers();
    const watchdog = new LockupWatchdog();
    watchdog.noteFrameReceived();
    vi.advanceTimersByTime(LOCKUP_SUSPECTED_MS + 1);
    expect(watchdog.isLockupSuspected()).toBe(true);
    watchdog.noteFrameReceived();
    expect(watchdog.isLockupSuspected()).toBe(false);
    vi.useRealTimers();
  });
});
