import { describe, expect, it, vi } from "vitest";
import { FrameReassembler, connectTransport } from "./transport.js";
import { buildFrame, buildReadFrame } from "./codec.js";
import {
  ADDR_APP,
  ADDR_CONTROLLER,
  ADDR_MODULE,
  CMD_READ_REPLY,
  READ_TIMEOUT_MS,
} from "./constants.js";
import { makeFakeCharacteristic, type FakeCharacteristic } from "./test-support.js";

/** Builds a reply frame as the bike would send it: src = the answering node, dst = the app. */
function buildReplyFrame(src: number, sub: number, data: Uint8Array): Uint8Array {
  return buildFrame(ADDR_APP, CMD_READ_REPLY, sub, data, src);
}

describe("FrameReassembler", () => {
  it("parses a single frame delivered whole", () => {
    const frame = buildFrame(ADDR_CONTROLLER, 0x04, 0x00, Uint8Array.of(1, 2, 3));
    const reassembler = new FrameReassembler();
    const parsed = reassembler.push(frame);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.dst).toBe(ADDR_CONTROLLER);
    expect(Array.from(parsed[0]?.data ?? [])).toEqual([1, 2, 3]);
  });

  it("reassembles a frame split across two notifications", () => {
    const frame = buildFrame(ADDR_CONTROLLER, 0x04, 0xa0, new Uint8Array(24).fill(7));
    const splitPoint = 10;
    const reassembler = new FrameReassembler();

    const first = reassembler.push(frame.slice(0, splitPoint));
    expect(first).toHaveLength(0); // not enough yet

    const second = reassembler.push(frame.slice(splitPoint));
    expect(second).toHaveLength(1);
    expect(second[0]?.crcOk).toBe(true);
    expect(second[0]?.data.length).toBe(24);
  });

  it("reassembles a frame split byte-by-byte", () => {
    const frame = buildFrame(ADDR_MODULE, 0x06, 0x01, new Uint8Array(21).fill(1));
    const reassembler = new FrameReassembler();
    let lastResult: ReturnType<FrameReassembler["push"]> = [];
    for (const byte of frame) {
      lastResult = reassembler.push(Uint8Array.of(byte));
    }
    expect(lastResult).toHaveLength(1);
    expect(lastResult[0]?.crcOk).toBe(true);
  });

  it("skips leading garbage bytes before the magic", () => {
    const frame = buildFrame(ADDR_CONTROLLER, 0x04, 0x00, Uint8Array.of(9));
    const withGarbage = new Uint8Array(3 + frame.length);
    withGarbage.set([0xde, 0xad, 0xbe], 0);
    withGarbage.set(frame, 3);
    const reassembler = new FrameReassembler();
    const parsed = reassembler.push(withGarbage);
    expect(parsed).toHaveLength(1);
    expect(Array.from(parsed[0]?.data ?? [])).toEqual([9]);
  });

  it("extracts two complete frames delivered in one notification", () => {
    const first = buildFrame(ADDR_CONTROLLER, 0x04, 0x00, Uint8Array.of(1));
    const second = buildFrame(ADDR_MODULE, 0x06, 0x01, Uint8Array.of(2));
    const merged = new Uint8Array(first.length + second.length);
    merged.set(first, 0);
    merged.set(second, first.length);
    const reassembler = new FrameReassembler();
    const parsed = reassembler.push(merged);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.dst).toBe(ADDR_CONTROLLER);
    expect(parsed[1]?.dst).toBe(ADDR_MODULE);
  });

  it("carries a lone leading magic byte across notifications", () => {
    const frame = buildFrame(ADDR_CONTROLLER, 0x04, 0x00, Uint8Array.of(5));
    const reassembler = new FrameReassembler();
    // First chunk ends with just the 0x55 half of the magic.
    const first = reassembler.push(frame.slice(0, 1));
    expect(first).toHaveLength(0);
    const second = reassembler.push(frame.slice(1));
    expect(second).toHaveLength(1);
    expect(Array.from(second[0]?.data ?? [])).toEqual([5]);
  });
});

// --- connectTransport, against a hand-rolled fake BluetoothDevice ---------------------------

function makeFakeDevice(writeChar: FakeCharacteristic, notifyChar: FakeCharacteristic) {
  return {
    gatt: {
      connect: vi.fn().mockResolvedValue({
        getPrimaryService: vi.fn().mockResolvedValue({
          getCharacteristics: vi.fn().mockResolvedValue([writeChar, notifyChar]),
        }),
      }),
      disconnect: vi.fn(),
    },
  } as unknown as BluetoothDevice;
}

describe("connectTransport", () => {
  it("resolves readRegister when a matching reply arrives", async () => {
    const writeChar = makeFakeCharacteristic("6e400002-b5a3-f393-e0a9-e50e24dcca9e", false);
    const notifyChar = makeFakeCharacteristic("6e400003-b5a3-f393-e0a9-e50e24dcca9e", true);
    const device = makeFakeDevice(writeChar, notifyChar);

    const transport = await connectTransport(device);
    const readPromise = transport.readRegister(ADDR_CONTROLLER, 160, 24);

    // The transport should have written a read request for offset 160.
    expect(writeChar.writeValueWithResponse).toHaveBeenCalledOnce();
    const sent = new Uint8Array(writeChar.writeValueWithResponse.mock.calls[0]![0] as ArrayBuffer);
    expect(sent[6]).toBe(160); // SUB echoes the requested offset

    const reply = buildReplyFrame(ADDR_CONTROLLER, 160, new Uint8Array(24).fill(9));
    notifyChar.emit(reply);

    const data = await readPromise;
    expect(data).toHaveLength(24);
    expect(data?.[0]).toBe(9);
  });

  it("resolves readRegister with undefined when nothing answers in time", async () => {
    vi.useFakeTimers();
    const writeChar = makeFakeCharacteristic("6e400002-b5a3-f393-e0a9-e50e24dcca9e", false);
    const notifyChar = makeFakeCharacteristic("6e400003-b5a3-f393-e0a9-e50e24dcca9e", true);
    const device = makeFakeDevice(writeChar, notifyChar);

    const transport = await connectTransport(device);
    const readPromise = transport.readRegister(ADDR_CONTROLLER, 96, 24);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1);
    expect(await readPromise).toBeUndefined();
    vi.useRealTimers();
  });

  it("delivers broadcast frames to onFrame listeners without an outstanding read", async () => {
    const writeChar = makeFakeCharacteristic("6e400002-b5a3-f393-e0a9-e50e24dcca9e", false);
    const notifyChar = makeFakeCharacteristic("6e400003-b5a3-f393-e0a9-e50e24dcca9e", true);
    const device = makeFakeDevice(writeChar, notifyChar);

    const transport = await connectTransport(device);
    const received: number[] = [];
    transport.onFrame((frame) => received.push(frame.sub));

    notifyChar.emit(buildFrame(ADDR_APP, 0x06, 0x01, new Uint8Array(21), ADDR_MODULE));
    notifyChar.emit(buildFrame(ADDR_APP, 0x06, 0x09, new Uint8Array(20), ADDR_MODULE));

    expect(received).toEqual([0x01, 0x09]);
  });

  it("does not resolve an unrelated read when a different offset replies", async () => {
    const writeChar = makeFakeCharacteristic("6e400002-b5a3-f393-e0a9-e50e24dcca9e", false);
    const notifyChar = makeFakeCharacteristic("6e400003-b5a3-f393-e0a9-e50e24dcca9e", true);
    const device = makeFakeDevice(writeChar, notifyChar);

    const transport = await connectTransport(device);
    const readPromise = transport.readRegister(ADDR_CONTROLLER, 160, 24);

    notifyChar.emit(buildReplyFrame(ADDR_CONTROLLER, 168, new Uint8Array(24)));
    let settled = false;
    void readPromise.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    notifyChar.emit(buildReplyFrame(ADDR_CONTROLLER, 160, new Uint8Array(24).fill(1)));
    expect(await readPromise).toHaveLength(24);
  });
});

// Sanity: buildReadFrame is exercised via connectTransport above, but confirm the SUB byte
// lines up with what the reassembler/matcher expects independently of the mocks.
describe("buildReadFrame + FrameReassembler round trip", () => {
  it("round-trips through the reassembler", () => {
    const request = buildReadFrame(ADDR_CONTROLLER, 168, 24);
    const reassembler = new FrameReassembler();
    const [parsed] = reassembler.push(request);
    expect(parsed?.sub).toBe(168);
    expect(parsed?.data[0]).toBe(24);
  });
});
