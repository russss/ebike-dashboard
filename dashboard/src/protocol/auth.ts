/**
 * §5 of the spec: the module challenges with AES-128-ECB over a single 16-byte block. Web
 * Crypto has no raw ECB mode, but AES-CBC with a zero IV computes `C1 = E(P1 XOR 0) = E(P1)`,
 * so the first 16 bytes of a zero-IV CBC encryption are exactly the ECB block we need.
 */
import { AUTH_KEY_HEX } from "./constants.js";
import { unhex } from "./bytes.js";

export async function computeAuthResponse(challenge: Uint8Array): Promise<Uint8Array> {
  const block = new Uint8Array(16);
  block.set(challenge.subarray(0, 16), 0); // zero-pad right (or truncate) to one block

  const key = await crypto.subtle.importKey("raw", unhex(AUTH_KEY_HEX), "AES-CBC", false, [
    "encrypt",
  ]);
  const cipherText = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: new Uint8Array(16) },
    key,
    block,
  );
  return new Uint8Array(cipherText).slice(0, 16);
}
