/**
 * Frame codec: `55 AA | LEN | SRC | DST | CMD | SUB | DATA[LEN] | CRC16`.
 * Pure functions, no I/O — see docs/ado-ble-protocol.md §2.
 */
import { ADDR_APP, MAGIC } from "./constants.js";
import type { Frame } from "./types.js";

/** 16-bit one's complement of the byte sum, little-endian. */
export function checksum(payload: Uint8Array): Uint8Array {
  let sum = 0;
  for (const byte of payload) sum += byte;
  const value = ~sum & 0xffff;
  return Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
}

export function buildFrame(
  dst: number,
  cmd: number,
  sub: number,
  data: Uint8Array = new Uint8Array(0),
  src: number = ADDR_APP,
): Uint8Array {
  if (data.length > 0xff) throw new RangeError("DATA must be <= 255 bytes");
  const payload = new Uint8Array(5 + data.length);
  payload.set([data.length, src, dst, cmd, sub], 0);
  payload.set(data, 5);
  const crc = checksum(payload);

  const frame = new Uint8Array(2 + payload.length + 2);
  frame.set(MAGIC, 0);
  frame.set(payload, 2);
  frame.set(crc, 2 + payload.length);
  return frame;
}

/** Returns `undefined` for anything that isn't a complete, well-formed frame. */
export function parseFrame(frame: Uint8Array): Frame | undefined {
  if (frame.length < 9 || frame[0] !== MAGIC[0] || frame[1] !== MAGIC[1]) return undefined;
  const len = frame[2]!;
  if (frame.length < 9 + len) return undefined;

  const data = frame.slice(7, 7 + len);
  const gotCrc = frame.slice(7 + len, 9 + len);
  const wantCrc = checksum(frame.slice(2, 7 + len));
  const crcOk = gotCrc[0] === wantCrc[0] && gotCrc[1] === wantCrc[1];

  return { len, src: frame[3]!, dst: frame[4]!, cmd: frame[5]!, sub: frame[6]!, data, crcOk };
}

/** Read command: SUB is the first register, DATA[0] the number of bytes wanted. */
export function buildReadFrame(dst: number, offset: number, length: number): Uint8Array {
  return buildFrame(dst, 0x01, offset, Uint8Array.of(length));
}
