# ADO e-bike dashboard

A live telemetry dashboard for the ADO e-bike, built with [Lit](https://lit.dev) and
[Vite](https://vitejs.dev). Connects over Web Bluetooth using the protocol documented in
[`../docs/ado-ble-protocol.md`](../docs/ado-ble-protocol.md).

This app only ever reads the fixed, confirmed-safe set of registers needed for live telemetry —
see `src/protocol/bike.ts` and `src/protocol/safety.ts`.

## Running it

```console
npm install
npm run dev
```

Open the printed `http://localhost:...` URL in **Chrome or Edge** — Web Bluetooth needs a secure
context (`localhost` counts) and isn't implemented by Safari or Firefox at all. On mobile, that
means **Android Chrome only** — there is no Web Bluetooth on iOS in any browser, with no
workaround.

To test from a phone on the same network, `vite --host` alone won't satisfy the secure-context
requirement over plain HTTP; you'll need local HTTPS (e.g.
[`@vitejs/plugin-basic-ssl`](https://www.npmjs.com/package/@vitejs/plugin-basic-ssl)) or a tunnel
that terminates TLS.

## Development

```console
npm run test        # vitest run, once
npm run test:watch  # vitest, watch mode
npx tsc --noEmit     # type-check only
npm run build         # type-check + production build
```

`src/protocol/` is the standalone TypeScript implementation of the BLE protocol — codec, auth
handshake, safety-range enforcement, decoders, and the `AdoBike` class that's the only supported
entry point. `src/ui/` is the Lit component tree consuming it; nothing there imports
`protocol/transport.ts` or calls anything that takes a raw register offset, by design.

There is no way to exercise real Web Bluetooth from an automated test — the protocol module's
pure logic (codec, decoders, the safety boundary) is thoroughly unit-tested, and `transport.ts`/
`bike.ts` are tested against a hand-rolled fake Bluetooth device, but connecting to an actual bike
has to be verified by hand.
