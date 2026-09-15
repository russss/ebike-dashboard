# How the ADO protocol was reverse-engineered

Working notes behind [`ado-ble-protocol.md`](./ado-ble-protocol.md): where the information came
from, how far each claim can be trusted, the official app's internals and bugs, and what is still
unknown. None of this is needed to implement the protocol — it is here so the spec can be audited
and extended.

## Contents

1. [The app](#1-the-app)
2. [Method](#2-method)
3. [The vendor's command table](#3-the-vendors-command-table)
4. [Establishing the frame layout](#4-establishing-the-frame-layout)
5. [The register insight](#5-the-register-insight)
6. [The app's own codec](#6-the-apps-own-codec)
7. [Navigation as the app implements it](#7-navigation-as-the-app-implements-it)
8. [Firmware distribution](#8-firmware-distribution)
9. [Validation against hardware](#9-validation-against-hardware)
10. [Bugs in the official app](#10-bugs-in-the-official-app)
11. [Still unknown](#11-still-unknown)

---

## 1. The app

| | |
|---|---|
| Package | `uni.UNI11FDFAE` |
| Name | `ADOEBIKE` |
| Version | `2.0.4.5` (versionCode `2045`) |
| Framework | DCloud **uni-app** — a JS/Vue hybrid |

The six DEX files are almost entirely framework: Mapbox, Weex, AMap, ijkplayer, the Google
Navigation SDK. **None of the protocol logic is in Java.** It all lives in a minified JavaScript
bundle at `assets/apps/__UNI__11FDFAE/www/app-service.js`, 636 KB of it, with the navigation code
split into `pages/map/*.js` and `pages/mapboxMap/*.js`.

The files that matter, by their original source names:

| Source file | Contents |
|---|---|
| `utils/blueApi.js` | Transport, framing, checksum, every value codec |
| `pages/index/index.vue` | Connection, authentication, status parsing |
| `pages/bikeset/bikeset.vue`, `info.vue`, `oinfo.vue` | Settings, one page per controller family |
| `pages/userinfo/userinfo.vue` | Firmware update |
| `pages/map/mapAndroid.nvue` | Navigation, Google Navigation SDK path |
| `pages/mapboxMap/map.nvue` | Navigation, Mapbox path (dead code — §10) |

A single device profile is hardcoded as a fallback and matches the bikes in the field: terminal
type `1590535223578619906`, vendor 辉烨 (Huiye), profile version `100`, dated 2022-11-09. It is the
source of the service UUIDs and the `55aa` frame magic.

## 2. Method

```
jadx -d decompiled base.apk                       # manifest, native glue, Maneuver enum
unzip base.apk 'assets/apps/__UNI__11FDFAE/www/*'  # the actual protocol logic
prettier --parser babel app-service.js             # 636 KB minified -> 48 k readable lines
```

`jadx` was only useful for three things: reading `AndroidManifest.xml` to discover this was a
uni-app hybrid at all, finding `io.dcloud.uniplugin.NavInfoReceivingService` (the bridge that
feeds navigation events to JS), and extracting the Google Navigation SDK's `Maneuver` enum
ordinals.

Every algorithm in the spec was **ported and executed** rather than read off. The checksum in
particular: the app's implementation is a chain of string manipulations, so it was transliterated
verbatim into JavaScript and compared against the clean formula over 200,000 random payloads.

## 3. The vendor's command table

The opcodes are **not in the app**. It fetches them at startup and caches them:

```
GET http://app.adoebike.cn:13110/app/appdata/listcode?terminalType=1590535223578619906
Header: token: <from login>
```

Retrieved with the owner's account and saved verbatim as
[`ado-opcode-table.json`](./ado-opcode-table.json) — 69 rows. Each has:

| Field | Meaning |
|---|---|
| `interfaceCode` | Symbolic name, e.g. `openlight`, `newadress`, or a field label like `D15` |
| `interfaceNo` | The literal hex bytes the app concatenates after `55AA` |
| `digit` | For reply fields, the byte offset(s) to read. `;`-separated for multi-byte |
| `children` | Field definitions belonging to a reply group |

`digit` is overloaded: a byte offset for telemetry fields, but a **comma-separated list of
navigation manoeuvre ids** under the navigation rows.

Related endpoints, all requiring a login token:

| Endpoint | Purpose |
|---|---|
| `app/appUser/login` | `{loginNo, type: 1, value: password}` → session token |
| `app/appdata/terminal` | BLE profile descriptors → [`ado-terminal-profile.json`](./ado-terminal-profile.json) |
| `app/appdata/listcode?terminalType=…` | The command table |
| `app/appUserProduct/list` | The account's bound bikes |
| `product/adoproductinfo/userFind?productId=…` | Product details |

The backend is plain **HTTP**, and `app/appUser/login` takes the account password in cleartext
JSON with no hashing. Credentials and the session token are exposed to anyone on the network path.

### The field labels

Reply fields are named `D0`, `D15`, `D0F` and so on. These labels are **scoped to their reply
group** and clash across groups — `D6` is the assist-level count in the live-status group but
maximum speed in the trip group; `D15` is the odometer in one and assist sensitivity in another.
The spec drops them in favour of plain offsets and register numbers, which are unambiguous. The
JSON keeps them, along with the original Chinese descriptions.

## 4. Establishing the frame layout

The header layout (`LEN SRC DST CMD SUB`) was not documented anywhere and had to be triangulated.

**The vendor table gives away the offsets.** Several rows exist only to tell the app where a
discriminator byte lives:

| Row | `digit` | Implication |
|---|---|---|
| `F2`, `F3` | `3` | These groups are identified by byte 3 → `SRC` |
| `20` | `5` | The auth-success constant is at byte 5 → `CMD` |
| `00`, `01`, `09`, `0B` | `6` | These groups are identified by byte 6 → `SUB` |

And `DATA` starts at byte 7: every field offset in the table is ≥ 7, and the app independently
does `frame.splice(7, …)` in its authentication, NFC and version parsers.

**`LEN` was confirmed by counting.** The `identification` row is the decisive one because the
vendor supplies it fully framed, checksum included:

```
55 AA 01 11 10 01 00 04 D8 FF
      ^^ ^^ ^^ ^^ ^^ ^^ ^^^^^
     LEN  |  |  |  | DATA  CRC
        SRC DST CMD SUB
```

`checksum(01 11 10 01 00 04)` = `D8 FF`. The interpretation then holds across every other
complete frame in the app:

| Command | Header | App appends | `LEN` | Actual `DATA` |
|---|---|---|---|---|
| `ide` | `10 11 10 20 00` | 16-byte AES block | `0x10` | 16 ✓ |
| `openlight` | `01 11 A5 03 A6` + `01` | — | 1 | 1 ✓ |
| `lunjing` | `02 11 F2 02 0F` | LE16 | 2 | 2 ✓ |
| `pwdopen` | `09 11 F2 02 02` | 1 + 4 + 4 bytes | 9 | 9 ✓ |
| `newadress` | `12 11 F1 03 00` | 18 bytes | `0x12` | 18 ✓ |
| `upload` (OTA) | `80 11` + `A5 08` + seq | 128-byte chunk | `0x80` | 128 ✓ |
| `reset` (OTA) | `00 11` + `A5 0A FA` | — | 0 | 0 ✓ |

The OTA data frame is the most convincing: a 128-byte firmware chunk implies `LEN = 0x80`, and the
app pads every chunk to exactly that.

Note how `interfaceNo` is structured — `LEN SRC DST CMD SUB`, sometimes with a fixed `DATA` prefix
appended. `openlight` bakes its whole payload in; `lunjing` stops after `SUB` and expects the app
to append a value; the OTA rows stop after `LEN SRC` because the app appends the target address
itself.

## 5. The register insight

The single most clarifying discovery: **`SUB` is a register address**, and the vendor's field label
`D<nn>` is that same register number in hex. It holds across all 26 read/write pairs — `lunjing`
writes `SUB=0x0F` and the value reads back as field `D0F`.

That in turn explained the read model: `CMD=0x01` means *read `DATA[0]` bytes starting at register
`SUB`*. Confirmed by reply lengths matching requested counts exactly:

| Request | Asked for | Reply `LEN` |
|---|---|---|
| `code` `0111a5011818` | `0x18` = 24 | 24 ✓ |
| `contorlCode` `0111a3010030` | `0x30` = 48 | 48 ✓ |
| `zpower` `0111a4010030` | `0x30` = 48 | 48 ✓ |
| `NFC` `0111a9010060` | `0x60` = 96 | 96 ✓ |

And then proven outright by two overlapping reads of the same node: `candsone` (`SUB=0x00`, 53
bytes) and `caninfo` (`SUB=0x30`, 5 bytes) returned `c8 00 fa 00 00` for registers `0x30`–`0x34`
in both cases — byte-identical, at data offsets 48 and 0 respectively. So `DATA[i]` is register
`SUB + i`.

### Resolving the ADS layout

The vendor table declares **two overlapping register blocks** for the ADS controller (`0xF2`) —
one covering registers `0x01`–`0x0D`, another `0x0E`–`0x1D` — at offsets that collide, so a single
reply cannot satisfy both. The app's two settings pages read one each, and both are triggered by
the same `zlms` command.

The read model settles it. `zlms` is `01 11 F2 01 01` + `0D`: thirteen bytes from register `0x01`,
which is exactly the first block's extent. So `bikeset.vue` is right and `info.vue`'s offsets are
stale vendor rows describing a longer read the app never issues.

This could not be confirmed on the wire because the test bike is a Bafang bike and never answers
`0xF2` at all. The spec flags those registers accordingly.

## 6. The app's own codec

`utils/blueApi.js` exports a set of helpers with actively misleading names. For anyone reading the
decompiled source:

| Helper | What it actually does |
|---|---|
| `hexCharCodeToStr(hex)` | Little-endian integer decode. Returns a **number**, not a string |
| `numExchange(hex)` | Byte-reverse a hex string |
| `adressCount(n)` | `round(n)` as LE32 |
| `adressPath(code, n)` | Icon in the high byte, `round(n)` in the low 24 bits, LE |
| `checkSumTwo(hex)` | Plain byte sum, zero-padded to 8 hex chars |
| `checkupdata(hex)` | Byte-reverse, right-pad to 4 bytes |
| `fileSize(chunks)` | Firmware byte count as LE32 |
| `hex2a(hex)` | ASCII, terminated at the first `00` |
| `parseHex(byte)` | `{percentage: byte & 0x7F, online: byte >> 7}` |
| `hexToDecimalBitRange(byte)` | Bits 3:2 as a 2-bit value |
| `milesToKm(v, unit)` | Converts km **to** miles. The name is backwards |

### The checksum

The app computes it as: sum the bytes, XOR with `0xFFFF`, stringify to hex, rotate the string left
by one byte, then split into pairs and reverse. That is an elaborate way to write a little-endian
one's complement, and the two agree over 200,000 random payloads.

They diverge only when the byte sum exceeds `0xF000`: the hex string then loses a leading zero and
the rotation produces garbage (sum `0xF001` → app `ff0e`, correct `fe0f`). Reaching that needs
241+ bytes of near-`0xFF` data. The largest real frame, a 134-byte all-`0xFF` firmware chunk,
still matches, so the bug is unreachable — but don't reimplement the string version.

### Scalar widths

Whether a setting is a scaled 16-bit value or a plain byte is decided in the app by a `type`
switch, not by anything in the table:

```js
// scaled: wheel diameter, undervoltage cut-off
i = ((10 * num).toString(16)).padStart(4, "0");  i = numExchange(i);   // 27.5 -> "1301"
// plain byte: magnet count, speed limit, sensitivity, strength, current limit
i = parseFloat(num).toString(16);                i = i.padStart(2, "0");
```

The register `LEN` in the vendor table agrees with this split, which is how the spec states it.

## 7. Navigation as the app implements it

The app resolves an icon code from the vendor table, keyed by the **Google Navigation SDK
`Maneuver` ordinal**, delivered to JS by `io.dcloud.uniplugin.NavInfoReceivingService` calling
`StepInfo.getManeuver()`. The shipped mapping:

| Icon | Manoeuvre ordinals |
|---|---|
| `0x01` straight | 1, 5, 16, 17, 18, 19, 20, 21, 30, 31, 32, 41, 42, 43, 44, 45, 46, 61, 62, 63, 64, 65 |
| `0x02` left | 6, 22, 33, 47, 48 |
| `0x03` right | 7, 23, 34, 49, 50 |
| `0x04` bear left | 8, 10, 24, 26, 35, 37, 51, 52 |
| `0x05` bear right | 9, 11, 25, 27, 36, 53, 54 |
| `0x06` sharp left | 12, 28, 39, 55, 56 |
| `0x07` sharp right | 13, 29, 40, 57, 58 |
| `0x08` U-turn left | 14, 60 |
| `0x09` U-turn right | 15, 59 |
| `0x0A` arrived | 2, 3, 4 |

Unmapped: `0` (`UNKNOWN`, which the app treats as end-of-route), `38` (`ROUNDABOUT_ENTER_CW`) and
`66` (`DESTINATION_RIGHT`).

**This mapping is substantially wrong.** Against the real enum:

- `2` `NAME_CHANGE`, `3` `KEEP_LEFT`, `4` `KEEP_RIGHT` → "arrived at destination"
- `63` `DESTINATION`, `64` `DESTINATION_STRAIGHT`, `65` `DESTINATION_LEFT` → "continue straight"
- `5` `TURN_SLIGHT_LEFT` → "straight"; `6` `TURN_SLIGHT_RIGHT` → "turn **left**";
  `7` `TURN_NORMAL_LEFT` → "turn **right**"
- `25` `OFF_RAMP_NORMAL_LEFT` and `27` `OFF_RAMP_SHARP_LEFT` → "bear **right**"

The low-numbered entries look as if they were authored against a different manoeuvre enumeration
altogether, and `27` appears twice. The icon vocabulary itself is sound; the mapping onto it is
not, which is why the spec documents the icons and leaves the mapping to the implementer.

For reference, the SDK's ordinals, from
`com.google.android.libraries.navigation.internal.tk.as`:

| # | Name | # | Name | # | Name |
|---|---|---|---|---|---|
| 0 | `UNKNOWN` | 23 | `OFF_RAMP_SLIGHT_LEFT` | 45 | `…CW_SHARP_LEFT` |
| 1 | `DEPART` | 24 | `OFF_RAMP_SLIGHT_RIGHT` | 46 | `…CW_NORMAL_LEFT` |
| 2 | `NAME_CHANGE` | 25 | `OFF_RAMP_NORMAL_LEFT` | 47 | `…CW_SLIGHT_LEFT` |
| 3 | `KEEP_LEFT` | 26 | `OFF_RAMP_NORMAL_RIGHT` | 48 | `…CW_U_TURN` |
| 4 | `KEEP_RIGHT` | 27 | `OFF_RAMP_SHARP_LEFT` | 49 | `ROUNDABOUT_ENTER_CCW` |
| 5 | `TURN_SLIGHT_LEFT` | 28 | `OFF_RAMP_SHARP_RIGHT` | 50 | `ROUNDABOUT_EXIT_CCW` |
| 6 | `TURN_SLIGHT_RIGHT` | 29 | `OFF_RAMP_KEEP_LEFT` | 51 | `ROUNDABOUT_ENTER_AND_EXIT_CCW` |
| 7 | `TURN_NORMAL_LEFT` | 30 | `OFF_RAMP_KEEP_RIGHT` | 52 | `…CCW_SHARP_RIGHT` |
| 8 | `TURN_NORMAL_RIGHT` | 31 | `OFF_RAMP_U_TURN_LEFT` | 53 | `…CCW_NORMAL_RIGHT` |
| 9 | `TURN_SHARP_LEFT` | 32 | `OFF_RAMP_U_TURN_RIGHT` | 54 | `…CCW_SLIGHT_RIGHT` |
| 10 | `TURN_SHARP_RIGHT` | 33 | `FORK_LEFT` | 55 | `…CCW_STRAIGHT` |
| 11 | `U_TURN_LEFT` | 34 | `FORK_RIGHT` | 56 | `…CCW_SHARP_LEFT` |
| 12 | `U_TURN_RIGHT` | 35 | `MERGE_LEFT` | 57 | `…CCW_NORMAL_LEFT` |
| 13 | `ON_RAMP_SLIGHT_LEFT` | 36 | `MERGE_RIGHT` | 58 | `…CCW_SLIGHT_LEFT` |
| 14 | `ON_RAMP_SLIGHT_RIGHT` | 37 | `MERGE` | 59 | `…CCW_U_TURN` |
| 15 | `ON_RAMP_NORMAL_LEFT` | 38 | `ROUNDABOUT_ENTER_CW` | 60 | `STRAIGHT` |
| 16 | `ON_RAMP_NORMAL_RIGHT` | 39 | `ROUNDABOUT_EXIT_CW` | 61 | `FERRY_BOAT` |
| 17 | `ON_RAMP_SHARP_LEFT` | 40 | `ROUNDABOUT_ENTER_AND_EXIT_CW` | 62 | `FERRY_TRAIN` |
| 18 | `ON_RAMP_SHARP_RIGHT` | 41 | `…CW_SHARP_RIGHT` | 63 | `DESTINATION` |
| 19 | `ON_RAMP_KEEP_LEFT` | 42 | `…CW_NORMAL_RIGHT` | 64 | `DESTINATION_STRAIGHT` |
| 20 | `ON_RAMP_KEEP_RIGHT` | 43 | `…CW_SLIGHT_RIGHT` | 65 | `DESTINATION_LEFT` |
| 21 | `ON_RAMP_U_TURN_LEFT` | 44 | `…CW_STRAIGHT` | 66 | `DESTINATION_RIGHT` |
| 22 | `ON_RAMP_U_TURN_RIGHT` | | | | |

Pushing navigation to the display is opt-in in the app, behind a `setMsg` preference.

## 8. Firmware distribution

Images come from the same REST backend, two calls per target:

| Target | Version check | Package download |
|---|---|---|
| Module | `app/appterminalversion/getNewVersion/{terminalType}?version={cur}` | `app/appterminalversion/getHexPackage/{id}` |
| Controller | `app/controllerVersion/getNewVersion?version={cur}&hardwareVersion={hw}` | `app/controllerVersion/getHexPackage/{id}` |
| Main battery | `app/mainPower/getNewVersion?version={cur}&hardwareVersion={hw}` | `app/mainPower/getHexPackage/{id}` |
| Second battery | `app/secondPower/getNewVersion?version={cur}&hardwareVersion={hw}` | `app/secondPower/getHexPackage/{id}` |

`{cur}` and `{hw}` are exactly what the bike reports over BLE. The controller and battery
endpoints reject empty parameters (`{"code":500,"msg":"参数为空"}`), so **you cannot fetch their
firmware without a bike to interrogate first** — the version strings are not derivable from the
account.

`getNewVersion` is keyed by the **source** version: it returns a record only when an upgrade
exists *from* the version you pass, and the record's `version` field echoes your input. The target
version is not in the response, only inside the package.

```jsonc
// GET app/appterminalversion/getNewVersion/1590535223578619906?version=B02H_C_ADS_IOT02_BF_N09
{ "code": 0, "msg": "success",
  "data": { "id": "2021502632979517442",
            "version": "B02H_C_ADS_IOT02_BF_N09",   // the FROM version, echoed back
            "isUpgrade": 1, "hardwareVersion": null } }
```

`getHexPackage/{id}` returns the image as a JSON array of 32-character hex strings. The app joins
them and re-chunks into 128-byte pieces. It never parses the `B04H` container — the whole blob
goes up and the module bootloader unpacks it.

### The retrieved module package

Saved under [`../firmware/`](../firmware/) with [`manifest.json`](../firmware/manifest.json).
Fetched 2026-09-15; the upgrade offered to a module running `B02H_C_ADS_IOT02_BF_N09`.

| | |
|---|---|
| File | `module_B02H_C_ADS_IOT02_BF_N11.bin` |
| Size | 507,904 bytes — exactly 3,968 × 128-byte chunks |
| SHA-256 | `7c0f71b921c0af611bf861e373193629d0d8285b1626a56d38ffc587546e9325` |
| Package version | `B02H_C_ADS_IOT02_BF_N11` |
| Byte sum for the verify frame | `0x03070831` |

| # | Id | Name | Offset | Length | CRC32 | Built |
|---|---|---|---|---|---|---|
| 0 | `0x4211` | `app_b02hc_f403a_bf_hmi_ads_iot02_crc` | `0x000180` | 335,752 | `0x283125A8` | 2026-02-10 11:12:25 |
| 1 | `0x4111` | `B02H_BOOT_PUB_V07` | `0x052110` | 20,184 | `0x67C48D5D` | 2026-02-10 11:10:20 |
| 2 | `0x4202` | `HY_B02H_BLE_ADS_V9_OTA` | `0x056FF0` | 151,568 | `0x7B9C4C04` | 2026-02-10 11:13:20 |

All three CRC32s verify as standard zlib CRC-32, and the section extents tile the file exactly to
the declared total size — which is what confirmed the container layout. Sections are extracted
individually under `firmware/sections/`.

Section 0 is the display application, 1 the bootloader, 2 the BLE stack. Reading the names:
`b02hc` is the board, `f403a` the MCU, `bf` Bafang, `hmi` the display app, `ads_iot02` the
ADS-protocol IoT variant, `HY` the vendor prefix (辉烨). Sections 0 and 1 both open with a
Cortex-M vector table — section 0 has initial `SP = 0x20013C90` and reset handler `0x0800C199`,
linking at the STM32 flash base `0x08000000` — so the module is an STM32-class part carrying a
complete bootloader, application and radio stack.

The bike tested already runs `N11`, the version inside this package, and `getNewVersion` returns
`null` for it.

## 9. Validation against hardware

[`../webapp/index.html`](../webapp/index.html) connects over Web Bluetooth, runs the handshake,
issues the read-only queries and checks every assertion in the spec against what comes back. Serve
it from localhost — Web Bluetooth needs a secure context — and use Chrome or Edge:

```console
$ python3 -m http.server -d webapp 8000
$ open http://localhost:8000/
```

It is read-only apart from the auth response, the queries, and an opt-in navigation test. It also
self-tests its own codec on load against the spec's vectors, so a broken page is distinguishable
from a surprising bike. That codec was cross-checked against
[`ado_protocol.py`](./ado_protocol.py) over 669 generated vectors — checksums, frames, turn
records, auth blocks — with no mismatches. `Download JSON` exports every frame plus the results.

### Runs

An ADO Air 20Pro, advertised name `ADO-EBIKE`, Chrome on Android.

**First run: 18 of 21 checks passed.** The navigation test put the expected left-turn arrow on the
display. The three that did not pass were all documentation or tooling faults:

| Check | Outcome |
|---|---|
| Auth challenge | `WARN` — 4 bytes, where the spec had claimed 16 |
| Settings reply | `SKIP` — the page only queried `0xF2`; this bike is Bafang and answers `0xF3` |
| Register block | `SKIP` — consequence of the above |

**Second run, after fixing the page: 22 of 22.** Both Bafang reads answered, and their overlap is
what proved the register-indexing rule in §5.

Confirmed across both runs: framing, `LEN` and checksum on all 284 received frames and all 31
transmitted ones; the characteristic roles; the handshake, where `ado_protocol.py` reproduces the
exact `ide` frame the bike accepted; both status groups at the documented offsets; the version,
capability, language and NFC replies; and the navigation push.

Corrections the hardware forced, all now folded into the spec:

- The challenge is 4 bytes, not 16
- Status reports carry `CMD=0x06` — the app never checks it, so it was not derivable statically
- Live-status offset 10 is populated, not unused
- Backlight level is a plain byte, not two nibbles
- Bit 7 of a battery byte does not mean presence

Two decoded values give independent confidence in the scaled-integer encoding, which was otherwise
only inferred from the app's encoder: wheel diameter reads exactly **20.0 in** on a bike called
*Air 20Pro*, and speed limit exactly **25.0 km/h** on a unit whose server record says *EU
Version*.

### On MTU

Web Bluetooth exposes no MTU control, so the test page cannot do what the app's `setBLEMTU(512)`
does, and a 30-byte status frame could in principle arrive split across notifications. In practice
Chrome on Android negotiated enough — a 105-byte NFC reply arrived in one notification and the
reassembly buffer never fired. It is still there, and reports if it is ever needed.

## 10. Bugs in the official app

These explain odd traffic, and none should be reproduced.

1. **The Mapbox navigation path can never fire.** `pages/mapboxMap/map.nvue` resolves the turn
   icon with `if (child.interfaceNo == maneuverInt)`, but the vendor's rows for that path carry
   *text labels* in `interfaceNo` (`"turn straight"`, `"turn left"`, …), not integers. The
   comparison never succeeds, and the frame is only built inside that branch — so the page pushes
   nothing to the display. Only the Google Navigation SDK path works.

2. **The manoeuvre → icon mapping is substantially wrong.** See §7.

3. **Card deletion sends a malformed frame.** The UID is a JavaScript *array* of hex byte strings,
   concatenated straight into a string:

   ```js
   "1011A902" + t + "000000000000000000000000000000000"
   ```

   Array-to-string coercion inserts commas, giving `1011A902` `04,1a,2b,…,e7` `000…0`. Two
   consequences:

   - `checkSum` walks the string two characters at a time, hits `",1"`, gets `NaN`, and since
     JavaScript's `NaN ^ 0xFFFF` is `0xFFFF`, **the checksum is always `ff ff`**.
   - The zero run is 33 characters — odd. The hex-to-bytes regex strips the commas, so the UID
     survives, but the trailing nibble is dropped and 16 zero bytes are appended instead of the
     intended padding.

   What actually goes on the wire for UID `04 1a … e7`:

   ```
   55aa 1011a902 041a2b3c4d5e6f708192a3b4c5d6e7 00000000000000000000000000000000 0fff
   ```

   Since enrolment mode uses `SUB=0x01`, the intended frame was almost certainly register `0x02`
   with the UID as data — `55 AA 10 11 A9 02 02 <15-byte UID> 00 <CRC>`, where `LEN=0x10` fits
   exactly. Whether the reader accepts the broken version, i.e. whether it validates checksums at
   all, is untested: confirming it would delete a card.

4. **Backlight level is read as two nibbles.** `getLight` splits the byte's hex digits into
   (number of levels, current level). Hardware reports `0x03`, so the app computes "level 3 of 0"
   and renders an empty picker. It is a plain level — the controller's own backlight register
   reads `3` too.

5. **The checksum degrades above a byte sum of `0xF000`.** See §6. Unreachable in practice.

6. **The two ADS register blocks overlap and one page has the wrong one.** See §5.

7. **The capability bitmap is parsed by indexing an unpadded binary string,** so the bit positions
   only land correctly when bit 7 is set. Hardware happens to report `0x87`, so the bug is latent
   rather than visible on this bike.

8. **The device profile's `readSerid` / `writeSerid` are swapped** relative to how the app uses
   them — `readSerid` is the characteristic it writes to. The app's own
   characteristic-resolution code ignores the names and matches on GATT properties instead, which
   is the only reason it works.

9. **A hardcoded PIN, `3824`,** gates "clear odometer" in the UI. It is a client-side check only;
   the command carries no authentication.

10. **`info.vue`'s `openlight()` is a misnomer** — it writes the voltage-selection register based
    on the battery-voltage field, nothing to do with lights.

11. **The bundled English label "Steel number"** is a mistranslation of 测速磁钢: it is the
    speed-sensor magnet count.

12. **`checkupdata` right-pads to 4 bytes and ignores overflow,** so a firmware image whose byte
    sum exceeds 32 bits would silently wrap.

## 11. Still unknown

| | |
|---|---|
| ADS register layout | Registers above `0x0D` on `0xF2` have never been seen on the wire; the layout rests on the read encoding alone. Needs a bike with an ADS controller |
| Card deletion | The exact payload, since the app's version is malformed and testing means losing a card |
| Battery byte, bit 7 | The app calls it `online`, but a full, plainly-connected battery reported it clear |
| Capability report | Offsets 13–32 of the 26-byte reply |
| Live status | Offset 10, consistently `0x01` |
| Trip statistics | Offsets 15, 17–18 and 22 match controller settings exactly, but from one sample — could be coincidence |
| Bafang registers | `0x0D`–`0x2F` read as zero and are unnamed |
| Working mode, riding mode, drive mode, distance setting, battery display type | Named by the vendor but their value spaces are undocumented |
