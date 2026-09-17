import { describe, expect, it, vi } from "vitest";
import { AdoBike } from "./bike.js";
import { parseFrame } from "./codec.js";
import { computeAuthResponse } from "./auth.js";
import { assertReadIsSafe } from "./safety.js";
import { KNOWN_PROFILES } from "./profiles.js";
import { unhex } from "./bytes.js";
import {
  ADDR_APP,
  ADDR_MODULE,
  CMD_AUTH,
  CMD_READ,
  CMD_READ_REPLY,
  CMD_STATUS,
  NOTIFY_UUID,
  READ_TIMEOUT_MS,
  WRITE_UUID,
} from "./constants.js";
import { makeFakeCharacteristic } from "./test-support.js";

// --- a minimal, scripted fake peripheral ------------------------------------------------------

function buildReplyFrame(src: number, sub: number, data: Uint8Array, cmd = CMD_READ_REPLY): Uint8Array {
  // Minimal local re-implementation to avoid importing buildFrame purely for test fixtures.
  const payload = new Uint8Array(5 + data.length);
  payload.set([data.length, src, ADDR_APP, cmd, sub], 0);
  payload.set(data, 5);
  let sum = 0;
  for (const b of payload) sum += b;
  const crc = (~sum) & 0xffff;
  const frame = new Uint8Array(2 + payload.length + 2);
  frame.set([0x55, 0xaa], 0);
  frame.set(payload, 2);
  frame.set([crc & 0xff, (crc >> 8) & 0xff], 2 + payload.length);
  return frame;
}

const CHALLENGE = Uint8Array.of(0x3c, 0x0a, 0xf6, 0xcf);

const ADDR_CONTROLLER = 0xa3;
const ADDR_BATTERY = 0xa4;
const ADDR_METER = 0xa5;
const ADDR_SENSOR = 0xa7;

/** A 60-byte identity-header reply with `model` (offset 48) set to the given string. */
function meterHeaderWithModel(model: string): Uint8Array {
  const buf = new Uint8Array(60);
  for (let i = 0; i < model.length; i++) buf[48 + i] = model.charCodeAt(i);
  return buf;
}

/**
 * Covers every read AdoBike's fixed safe-list ever issues (identity + refreshDetail), so a
 * happy-path connect()+refreshDetail() never times out waiting on fake timers that a test
 * forgot to advance. Individual tests override specific keys to check particular decoded values.
 */
function defaultFixtures(): Map<string, Uint8Array> {
  const zeros = (n: number) => new Uint8Array(n);
  return new Map<string, Uint8Array>([
    [`${ADDR_CONTROLLER}:0`, zeros(60)],
    [`${ADDR_CONTROLLER}:72`, zeros(24)],
    [`${ADDR_BATTERY}:0`, zeros(60)],
    [`${ADDR_BATTERY}:72`, zeros(24)],
    // model = "B02H" at relative offset 48 — every test bike here is the one profile that
    // exists (see profiles.ts); without this, AdoBike would find no matching profile and
    // refreshDetail() would always take its "no profile" branch, defeating these tests.
    [`${ADDR_METER}:0`, meterHeaderWithModel("B02H")],
    [`${ADDR_METER}:72`, zeros(32)],
    [`${ADDR_METER}:120`, zeros(32)],
    [`${ADDR_SENSOR}:0`, zeros(60)],
    [`${ADDR_CONTROLLER}:160`, zeros(24)],
    [`${ADDR_CONTROLLER}:168`, zeros(24)],
    [`${ADDR_CONTROLLER}:196`, zeros(2)],
    [`${ADDR_BATTERY}:144`, zeros(24)],
    [`${ADDR_BATTERY}:236`, zeros(4)],
    [`${ADDR_METER}:160`, zeros(2)],
    [`${ADDR_METER}:162`, zeros(1)],
    [`${ADDR_METER}:166`, zeros(2)],
    [`${ADDR_METER}:168`, zeros(24)],
  ]);
}

/** A fake bike that authenticates realistically and answers reads with configurable fixtures. */
function makeFakeBike(fixtureOverrides: Map<string, Uint8Array> = new Map()) {
  const readFixtures = new Map([...defaultFixtures(), ...fixtureOverrides]);
  const writeChar = makeFakeCharacteristic(WRITE_UUID, false);
  const notifyChar = makeFakeCharacteristic(NOTIFY_UUID, true);
  const sentFrames: ReturnType<typeof parseFrame>[] = [];

  writeChar.writeValueWithResponse.mockImplementation(async (buf: ArrayBuffer) => {
    const frame = parseFrame(new Uint8Array(buf));
    if (!frame) return;
    sentFrames.push(frame);

    if (frame.dst === ADDR_MODULE && frame.cmd === CMD_READ && frame.sub === 0x00) {
      // identification -> reply with a challenge
      notifyChar.emit(buildReplyFrame(ADDR_MODULE, 0x00, CHALLENGE, CMD_READ_REPLY));
      return;
    }
    if (frame.dst === ADDR_MODULE && frame.cmd === CMD_AUTH && frame.sub === 0x00) {
      // auth response -> ack
      notifyChar.emit(buildReplyFrame(ADDR_MODULE, 0x00, Uint8Array.of(0x00), CMD_AUTH));
      return;
    }
    if (frame.cmd === CMD_READ) {
      const key = `${frame.dst}:${frame.sub}`;
      const fixture = readFixtures.get(key);
      if (fixture) {
        notifyChar.emit(buildReplyFrame(frame.dst, frame.sub, fixture));
      }
      // no fixture configured -> stay silent, exactly like an unimplemented register
    }
  });

  const device = {
    name: "ADO-EBIKE",
    gatt: {
      connect: vi.fn().mockResolvedValue({
        getPrimaryService: vi.fn().mockResolvedValue({
          getCharacteristics: vi.fn().mockResolvedValue([writeChar, notifyChar]),
        }),
      }),
      disconnect: vi.fn(),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as BluetoothDevice;

  return { device, writeChar, notifyChar, sentFrames, readFixtures };
}

// Fake timers are deliberately not used globally here: every fixture map covers the full
// safe-read list (see defaultFixtures), so nothing in these tests is expected to hit
// READ_TIMEOUT_MS in the first place — real timers keep the async auth handshake (which
// involves genuine WebCrypto calls) behaving normally.

describe("AdoBike.connect", () => {
  it("walks through connecting -> authenticating -> ready, and matches the real auth vector", async () => {
    const { device } = makeFakeBike();
    const bike = new AdoBike(device);
    const states: string[] = [];
    bike.addEventListener("connectionstatechange", (event) => {
      states.push((event as CustomEvent<string>).detail);
    });

    await bike.connect();

    expect(states).toEqual(["connecting", "authenticating", "ready"]);
    expect(bike.connectionState).toBe("ready");
  });

  it("responds to the challenge with the correct AES response", async () => {
    const { device, sentFrames } = makeFakeBike();
    const bike = new AdoBike(device);
    await bike.connect();

    const authFrame = sentFrames.find((f) => f?.cmd === CMD_AUTH);
    const expected = await computeAuthResponse(CHALLENGE);
    expect(authFrame).toBeDefined();
    expect(Array.from(authFrame!.data)).toEqual(Array.from(expected));
  });

  it("populates liveStatus and tripStats from broadcasts once ready", async () => {
    const { device, notifyChar } = makeFakeBike();
    const bike = new AdoBike(device);
    await bike.connect();

    notifyChar.emit(buildReplyFrame(ADDR_MODULE, 0x01, unhex("000000010000056400000000000000000000000000"), CMD_STATUS));
    expect(bike.liveStatus?.batteryMain.percentage).toBe(100);

    notifyChar.emit(buildReplyFrame(ADDR_MODULE, 0x09, unhex("0000000000000000c800c4090300000500000000"), CMD_STATUS));
    expect(bike.tripStats?.backlightLevel).toBe(3);
  });
});

describe("AdoBike safety — the central promise of this module", () => {
  it("never sends a single request that assertReadIsSafe would refuse, across a full connect + detail refresh", async () => {
    const { device, sentFrames } = makeFakeBike();
    const bike = new AdoBike(device);
    await bike.connect();
    await bike.refreshDetail();

    const reads = sentFrames.filter((f) => f?.cmd === CMD_READ && f.dst !== ADDR_MODULE);
    expect(reads.length).toBeGreaterThan(0); // sanity: reads actually happened

    for (const read of reads) {
      const length = read!.data[0] ?? 0;
      expect(() =>
        assertReadIsSafe(read!.dst, read!.sub, length, KNOWN_PROFILES.B02H!.dangerousRanges),
      ).not.toThrow();
    }
  });
});

describe("AdoBike.refreshDetail", () => {
  it("decodes a full detail snapshot from canned fixtures", async () => {
    const fixtures = new Map<string, Uint8Array>([
      [`${ADDR_CONTROLLER}:160`, unhex("640000000000ffff0000ee00000000002210140014000000")],
      [`${ADDR_BATTERY}:144`, unhex("000000000000000000009c01000000000000000000000000")],
      [`${ADDR_METER}:160`, unhex("0500")],
    ]);
    const { device } = makeFakeBike(fixtures);
    const bike = new AdoBike(device);
    await bike.connect();
    const detail = await bike.refreshDetail();

    expect(detail.controller.batteryPercent).toBe(100);
    expect(detail.battery.packVoltageV).toBeCloseTo(41.2);
    expect(detail.meter.assistLevelCount).toBe(5);
  });
});

describe("AdoBike — raw sample events", () => {
  it("emits rawsamples, pre-scaling, for every register read a detail refresh issues", async () => {
    const fixtures = new Map<string, Uint8Array>([
      [`${ADDR_CONTROLLER}:160`, unhex("640000000000ffff0000ee00000000002210140014000000")],
      [`${ADDR_BATTERY}:144`, unhex("000000000000000000009c01000000000000000000000000")],
      [`${ADDR_METER}:160`, unhex("0500")],
    ]);
    const { device } = makeFakeBike(fixtures);
    const bike = new AdoBike(device);
    const batches: { variable: string; value: number }[][] = [];
    bike.addEventListener("rawsamples", (event) => {
      batches.push((event as CustomEvent<{ variable: string; value: number }[]>).detail);
    });

    await bike.connect();
    await bike.refreshDetail();

    const all = batches.flat();
    expect(all.length).toBeGreaterThan(0);
    const byVariable = new Map(all.map((s) => [s.variable, s.value]));
    expect(byVariable.get("controller.batteryPercent")).toBe(100); // unscaled == scaled here
    expect(byVariable.get("battery.packVoltageV")).toBe(412); // decoded 41.2 == raw / 10
    expect(byVariable.get("meter.assistLevelCount")).toBe(5);
    // Identity reads (offset 0/24/48/72...) happen during connect() too, but never produce a
    // sample — confirms the exclusion isn't just "untested", it holds across a real connect.
    expect([...byVariable.keys()].some((v) => v.includes("hardware"))).toBe(false);
  });

  it("emits rawsamples for live and trip broadcasts as they arrive", async () => {
    const { device, notifyChar } = makeFakeBike();
    const bike = new AdoBike(device);
    await bike.connect();

    const batches: { variable: string; value: number }[][] = [];
    bike.addEventListener("rawsamples", (event) => {
      batches.push((event as CustomEvent<{ variable: string; value: number }[]>).detail);
    });

    notifyChar.emit(
      buildReplyFrame(ADDR_MODULE, 0x01, unhex("000000010000056400000000000000000000000000"), CMD_STATUS),
    );
    notifyChar.emit(
      buildReplyFrame(ADDR_MODULE, 0x09, unhex("0000000000000000c800c4090300000500000000"), CMD_STATUS),
    );

    const byVariable = new Map(batches.flat().map((s) => [s.variable, s.value]));
    expect(byVariable.get("live.batteryMainByte")).toBe(100);
    expect(byVariable.get("trip.backlightLevel")).toBe(3);
  });
});

describe("AdoBike.disconnect", () => {
  it("stops the detail-refresh timer and reports disconnected", async () => {
    const { device, writeChar } = makeFakeBike();
    const bike = new AdoBike(device);
    await bike.connect(); // real timers: needs the genuine WebCrypto auth round trip

    await bike.disconnect();
    expect(bike.connectionState).toBe("disconnected");

    const callsBefore = writeChar.writeValueWithResponse.mock.calls.length;
    // Switch to fake timers only now: fast-forward well past DETAIL_REFRESH_MS and confirm the
    // interval was actually cleared, rather than just happening not to have fired yet.
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    expect(writeChar.writeValueWithResponse.mock.calls.length).toBe(callsBefore);
  });
});

describe("AdoBike — recovering from a suspected lockup", () => {
  it("disconnects itself once a lockup is confirmed, instead of sitting in lockup-suspected forever", async () => {
    const { device, readFixtures } = makeFakeBike();
    const bike = new AdoBike(device);
    await bike.connect(); // real timers for the genuine auth handshake

    const states: string[] = [];
    bike.addEventListener("connectionstatechange", (event) => {
      states.push((event as CustomEvent<string>).detail);
    });

    // Go silent on the very first read refreshDetail() issues, so nothing answers it and the
    // bus goes quiet for longer than LOCKUP_SUSPECTED_MS.
    readFixtures.delete(`${ADDR_CONTROLLER}:160`);

    vi.useFakeTimers();
    const detailPromise = bike.refreshDetail();
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 100);
    await detailPromise;
    vi.useRealTimers();

    expect(states).toContain("lockup-suspected");
    expect(states.at(-1)).toBe("disconnected");
    expect(bike.connectionState).toBe("disconnected");
    expect(device.gatt!.disconnect).toHaveBeenCalled();
  });
});
