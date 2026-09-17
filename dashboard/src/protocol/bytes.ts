/** Byte-level primitives shared by the codec, field decoders and auth handshake. */

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function unhex(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/[^0-9a-fA-F]/g, "");
  const pairs = clean.match(/../g) ?? [];
  return Uint8Array.from(pairs, (pair) => parseInt(pair, 16));
}

/** Little-endian unsigned integer, 1-4 bytes. */
export function leUint(bytes: Uint8Array): number {
  let value = 0;
  for (let i = bytes.length - 1; i >= 0; i--) {
    value = value * 256 + (bytes[i] ?? 0);
  }
  return value;
}

/** Little-endian signed integer, 1-4 bytes (two's complement). */
export function leInt(bytes: Uint8Array): number {
  const unsigned = leUint(bytes);
  const bits = bytes.length * 8;
  const signBit = 2 ** (bits - 1);
  return unsigned >= signBit ? unsigned - 2 ** bits : unsigned;
}

/** NUL-terminated ASCII string, ignoring any trailing padding. */
export function asciiString(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

export interface BatteryByte {
  readonly percentage: number;
  readonly online: boolean;
}

/** Battery status byte: low 7 bits are percentage, high bit is online/offline. */
export function batteryByte(byte: number): BatteryByte {
  return { percentage: byte & 0x7f, online: (byte & 0x80) !== 0 };
}
