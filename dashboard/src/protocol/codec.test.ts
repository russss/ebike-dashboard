import { describe, expect, it } from "vitest";
import { buildFrame, buildReadFrame, checksum, parseFrame } from "./codec.js";
import { unhex, hex } from "./bytes.js";
import { ADDR_CONTROLLER, ADDR_MODULE, ADDR_METER, IDENTIFICATION_FRAME_HEX } from "./constants.js";

// Vectors ported verbatim from docs/ado_protocol.py's self-test, which has been
// cross-checked against a real ADO Air 20Pro (see reverse-engineering.md §10).
describe("checksum", () => {
  it("matches the vendor's own opcode table", () => {
    expect(hex(checksum(unhex("011110010004")))).toBe("d8ff");
    expect(hex(checksum(unhex("0611a70300112233445566")))).toBe("d9fd");
    expect(hex(checksum(unhex("0111f1010101")))).toBe("f9fe");
  });
});

describe("buildFrame", () => {
  it("reproduces the vendor's identification frame byte-for-byte", () => {
    // payload "011110010004" -> LEN=01 SRC=11 DST=10 CMD=01 SUB=00 DATA=04
    const built = buildFrame(ADDR_MODULE, 0x01, 0x00, Uint8Array.of(0x04));
    expect(hex(built)).toBe(IDENTIFICATION_FRAME_HEX);
  });

  it("reproduces known vendor opcode headers", () => {
    // openlight
    expect(hex(buildFrame(ADDR_METER, 0x03, 0xa6, unhex("01")).slice(2, 7))).toBe("0111a503a6");
  });
});

describe("buildReadFrame", () => {
  it("matches the vendor's contorlCode/zlms reads", () => {
    expect(hex(buildReadFrame(ADDR_CONTROLLER, 0x00, 0x30).slice(2, 8))).toBe("0111a3010030");
  });
});

describe("parseFrame", () => {
  it("round-trips a built frame", () => {
    const built = buildFrame(ADDR_CONTROLLER, 0x03, 0x00, new Uint8Array(18));
    const parsed = parseFrame(built);
    expect(parsed?.crcOk).toBe(true);
    expect(parsed?.len).toBe(18);
    expect(parsed?.dst).toBe(ADDR_CONTROLLER);
  });

  it("rejects frames with bad magic", () => {
    expect(parseFrame(unhex("00000000000000000000"))).toBeUndefined();
  });

  it("rejects truncated frames", () => {
    expect(parseFrame(unhex("55aa05001110040102"))).toBeUndefined();
  });

  it("flags a corrupted checksum without throwing", () => {
    const built = buildFrame(ADDR_CONTROLLER, 0x03, 0x00, unhex("01"));
    const corrupted = built.slice();
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff;
    expect(parseFrame(corrupted)?.crcOk).toBe(false);
  });
});
