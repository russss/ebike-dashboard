/**
 * Web Bluetooth GATT session: connect, resolve characteristics, write, and reassemble frames
 * from notifications. Web Bluetooth gives no MTU control, so a frame can arrive split across
 * several notifications — {@link FrameReassembler} handles that, kept separate from the GATT
 * plumbing so it can be unit tested without a real Bluetooth stack.
 */
import { buildReadFrame, parseFrame } from "./codec.js";
import {
  CMD_READ_REPLY,
  MAGIC,
  NOTIFY_UUID,
  READ_TIMEOUT_MS,
  SERVICE_UUID,
  WRITE_UUID,
} from "./constants.js";
import type { Frame } from "./types.js";

function findMagic(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === MAGIC[0] && bytes[i + 1] === MAGIC[1]) return i;
  }
  return -1;
}

/** Accumulates raw notification bytes and yields complete, parsed frames as they become available. */
export class FrameReassembler {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    let cursor = concat(this.#buffer, chunk);
    const frames: Frame[] = [];

    for (;;) {
      const magicIndex = findMagic(cursor);
      if (magicIndex < 0) {
        // No magic anywhere in what's left; keep the final byte in case it's a lone 0x55 that
        // the next chunk completes into 0x55 0xAA.
        cursor = cursor.length > 1 ? cursor.subarray(cursor.length - 1) : cursor;
        break;
      }
      if (magicIndex > 0) cursor = cursor.subarray(magicIndex);
      if (cursor.length < 3) break; // not even enough to know LEN yet

      const need = 9 + cursor[2]!;
      if (cursor.length < need) break; // wait for more notifications

      const frame = parseFrame(cursor.subarray(0, need));
      if (frame) frames.push(frame);
      cursor = cursor.subarray(need);
    }

    this.#buffer = cursor.slice(); // copy out — the source chunk's buffer may be reused by the OS
    return frames;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
}

export interface AdoTransport {
  send(frame: Uint8Array): Promise<void>;
  /** Resolves with the reply's DATA field, or `undefined` if nothing answered within {@link READ_TIMEOUT_MS}. */
  readRegister(node: number, offset: number, length: number): Promise<Uint8Array | undefined>;
  /** Subscribes to every parsed frame (replies and broadcasts alike). Returns an unsubscribe function. */
  onFrame(listener: (frame: Frame, receivedAt: number) => void): () => void;
  disconnect(): void;
}

interface PendingRead {
  readonly src: number;
  readonly sub: number;
  readonly resolve: (data: Uint8Array | undefined) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export async function connectTransport(device: BluetoothDevice): Promise<AdoTransport> {
  const server = await device.gatt?.connect();
  if (!server) throw new Error("device has no GATT server");

  const service = await server.getPrimaryService(SERVICE_UUID);
  const characteristics = await service.getCharacteristics();

  const writeChar =
    characteristics.find((c) => c.uuid === WRITE_UUID) ??
    characteristics.find((c) => c.properties.write || c.properties.writeWithoutResponse);
  const notifyChar =
    characteristics.find((c) => c.uuid === NOTIFY_UUID) ??
    characteristics.find((c) => c.properties.notify || c.properties.indicate);
  if (!writeChar || !notifyChar) {
    throw new Error("could not resolve both read and write characteristics");
  }
  const writeMode: "response" | "noResponse" = writeChar.properties.write
    ? "response"
    : "noResponse";

  const reassembler = new FrameReassembler();
  const frameListeners = new Set<(frame: Frame, receivedAt: number) => void>();
  const pendingReads: PendingRead[] = [];

  function handleNotification(value: DataView): void {
    const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    for (const frame of reassembler.push(chunk)) {
      const receivedAt = Date.now();
      for (const listener of frameListeners) listener(frame, receivedAt);

      if (frame.cmd === CMD_READ_REPLY) {
        const index = pendingReads.findIndex((p) => p.src === frame.src && p.sub === frame.sub);
        if (index >= 0) {
          const [match] = pendingReads.splice(index, 1);
          clearTimeout(match!.timer);
          match!.resolve(frame.data);
        }
      }
    }
  }

  notifyChar.addEventListener("characteristicvaluechanged", (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    if (target.value) handleNotification(target.value);
  });
  await notifyChar.startNotifications();

  async function send(frame: Uint8Array): Promise<void> {
    if (writeMode === "response") await writeChar!.writeValueWithResponse(frame.buffer as ArrayBuffer);
    else await writeChar!.writeValueWithoutResponse(frame.buffer as ArrayBuffer);
  }

  function removePendingRead(timer: ReturnType<typeof setTimeout>): void {
    const index = pendingReads.findIndex((p) => p.timer === timer);
    if (index >= 0) pendingReads.splice(index, 1);
  }

  function readRegister(
    node: number,
    offset: number,
    length: number,
  ): Promise<Uint8Array | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        removePendingRead(timer);
        resolve(undefined);
      }, READ_TIMEOUT_MS);
      pendingReads.push({ src: node, sub: offset, resolve, timer });

      send(buildReadFrame(node, offset, length)).catch(() => {
        clearTimeout(timer);
        removePendingRead(timer);
        resolve(undefined);
      });
    });
  }

  function onFrame(listener: (frame: Frame, receivedAt: number) => void): () => void {
    frameListeners.add(listener);
    return () => frameListeners.delete(listener);
  }

  function disconnect(): void {
    device.gatt?.disconnect();
  }

  return { send, readRegister, onFrame, disconnect };
}
