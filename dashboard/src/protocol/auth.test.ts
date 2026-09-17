import { describe, expect, it } from "vitest";
import { computeAuthResponse } from "./auth.js";
import { hex, unhex } from "./bytes.js";

// Vector ported from docs/ado_protocol.py's self-test.
describe("computeAuthResponse", () => {
  it("matches the reference AES-128-ECB vector", async () => {
    const response = await computeAuthResponse(unhex("00112233445566778899aabbccddeeff"));
    expect(hex(response)).toBe("67d228ce5f51bb500fe42c9a436d2ee8");
  });

  it("zero-pads a short (real hardware) challenge", async () => {
    // The exact response an ADO Air 20Pro accepted for its 4-byte challenge (§5).
    const response = await computeAuthResponse(unhex("3c0af6cf"));
    expect(hex(response)).toBe("99115f40211f1dfcf1b5a62ee4959c79");
  });
});
