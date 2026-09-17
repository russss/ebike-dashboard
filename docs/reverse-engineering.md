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
9. [Cross-referencing the Bafang Go app](#9-cross-referencing-the-bafang-go-app)
10. [Validation against hardware](#10-validation-against-hardware)
11. [Bugs in the official app](#11-bugs-in-the-official-app)
12. [Still unknown](#12-still-unknown)

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
| `pages/mapboxMap/map.nvue` | Navigation, Mapbox path (dead code — §11) |

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

## 9. Cross-referencing the Bafang Go app

ADO's motor, battery and display are Bafang components (§5, §8), so Bafang's own app is a second
independent source for the same wire protocol — and unlike the ADO app, it is barely obfuscated.

### The app

`apk-bafang-go/` — package `com.bafangen.ride`, "Bafang Go". A native Kotlin app, not a uni-app
hybrid, so the protocol logic is in the DEX. Two packages matter:

| Package | Role |
|---|---|
| `com.bafang.app.sdk.ble.client` | Bafang's own BLE client — device discovery, session management, two alternative wire protocols |
| `com.omni.support.ble` | A licensed-in BLE SDK (vendor "Omni") implementing several framed protocols, one of which is `aa55` |

`com.bafang.app.sdk.ble.client.BAFBluetoothAdapter` identifies a nearby device by which GATT
service UUID it advertises, and picks a protocol accordingly:

| Advertised service UUID | Module type | Protocol used |
|---|---|---|
| `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | `OMI` | `com.omni.support.ble` — AA55 framing |
| `49d554a6-76b1-11e9-8f9e-2a86e4085a59` | `PL` | `com.bafang.app.sdk.ble.client.can.BafangCan` — a newer, unrelated CAN-over-BLE protocol |
| `0000ffe0-0000-1000-8000-00805f9b34fb` | `TD` | (not explored) |

**The first row is ADO's service UUID.** So to Bafang's own app, an ADO bike is an ordinary `OMI`
module, handled by `OmBleClient`, which is a thin wrapper around `com.omni.support.ble`. This is
independent confirmation that the framing in §2 is not an ADO invention — it is a module vendor's
standard protocol that ADO licensed along with the hardware, and other e-bike brands using the
same Bafang OMI module speak the identical wire format.

### The AA55 protocol matches byte-for-byte

`com.omni.support.ble.protocol.base.aa55.AA55Pack` and `AA55PackAdapter` implement exactly the
framing in spec §2 and §4, independently of anything in the ADO app:

```java
// AA55PackAdapter.onNotify — reading a frame
if ((queue.take() & 255) != 170) { ... }      // second magic byte, 0xAA
frame[2] = queue.take();                       // LEN
int len = frame[2] + 2;
frame[3] = queue.take();  frame[4] = queue.take();   // SRC, DST, as received on the wire
frame[5] = queue.take();  frame[6] = queue.take();   // CMD, SUB
for (i in 0 until len) frame[7 + i] = queue.take();  // DATA
```

```java
// AA55Pack — building a frame
public static final int START_ID = 17;   // 0x11 — matches spec §3's phone address exactly
buf.putU8(85); buf.putU8(170);           // 0x55 0xAA
buf.putU8(length - 2);                   // LEN
buf.putU8(17);                            // SRC = 0x11
buf.putU8(targetId);                      // DST
buf.putU8(command);                       // CMD
// ...payload...
return getCheckSum(buffer);               // appends the checksum
```

And the checksum:

```java
private final boolean checkSum(byte[] data) {
    int sum = 0;
    for (i in 2 until data.length - 2) sum += data[i] & 255;   // LEN through last DATA byte
    // ... compared against the trailing two bytes
}
```

This is the same one's-complement-of-the-byte-sum construction as spec §2, over the same byte range.
`START_ID = 0x11` matching the ADO app's phone address, and `LEN` counting `DATA` only, are not
things two independent reverse-engineering efforts would coincidentally agree on — this is the
same protocol, read from the vendor's own source rather than inferred from an obfuscated client.

### The command set

`com.omni.support.ble.protocol.meter.MeterCommands` declares the full command vocabulary via
annotations (`@CommandID(n)`), which resolved several things that static analysis of the ADO app
alone could not, and that otherwise needed a hardware capture (§10) to pin down:

| `CMD` | Method | Notes |
|---|---|---|
| `0x01` | `meterRead(target, offset, length)` | Confirms the read model in §5 exactly |
| `0x02` | `meterWrite(target, offset, data)` | |
| `0x06` | `meterMonitor(target, offset, length)` | **Not a fixed status broadcast** — a *subscription*, with the same arguments as a read. The two ADO status groups are the module (`0x10`) monitoring its own registers `0x01` and `0x09` |
| `0x07`–`0x09` | `startUpgrade` / `sendUpgradeData` / `upgradeCheck` | Matches spec §12 exactly, including `startUpgrade` taking a `fileLength` |
| `0x0A` | `deviceReset` | |
| `0x0C` | `cancelUpgrade` | |
| `0x20`–`0x23` | `certification`, `eventNotification`, `navigationMapUpdate*`, `navigationFontUpdate` | Not used by the ADO app. `certification` at `0x20` is presumably a generalisation of the fixed-key handshake ADO actually uses |
| `0x30`–`0x35` | A second-generation upgrade flow (`startUpgradeV2`, etc.) | Not used by the ADO app |

This settled an open question from spec §4/§7: `CMD=0x06` was known only as "the code the ADO module
happens to use for its two status pushes," with no way to tell whether it was a fixed broadcast or
something the client requests. It is `meterMonitor` — a read request that keeps a subscription
open — which is why the ADO app never sends it: the module starts monitoring its own registers
unprompted, before authentication even, and no client ever asks it to.

### The device tables

The real payoff is `com.omni.support.ble.protocol.meter.bf` — per-device-type data classes with a
`setBuffer(ByteArray)` that is a literal field-by-field parse of a fixed-layout table, one class
per Bafang device type (`BfControllerInfo`, `BfBatteryInfo`, `BfMeterInfo`, `BfSensorInfo`, and
four more for IoT/tracker variants ADO's hardware doesn't have). These are §14 of the spec.

Reconstructing each class's field offsets against its own `buffer.length < N` guard is a strong
self-check: get the field widths right and the running offset lands exactly on the declared
minimum length. It did, for every table that has such a guard:

| Table | Declared length | Reconstructed length |
|---|---|---|
| `BfControllerInfo` | 237 | 237 |
| `BfBatteryInfo` | 244 | 244 |
| `BfMeterInfo` | 198 | 198 |
| `BfSensorInfo` | 164 | 164 |

Units and scaling came from two places that had to agree: the field-level constants (e.g.
`this.controllerTemperature = bufferConverter2.getU16() - 40`) and each class's `toString()`,
which the vendor apparently uses for their own debug logging and spells out in prose — e.g.
`"电流="+current+"(0.01A)"`. Where both exist they matched in every case checked.

`BufferConverter2.getU16()` reads little-endian, consistent with everything else in this protocol
family.

### What Bafang Go itself requests

`BfMeterCommands`'s own callers (§9) show exactly what offset and length Bafang's reference app
sends for each table — not a generic byte-range API used cautiously, but the app's normal,
every-time behaviour:

| Call | `meterRead(type, offset, length)` |
|---|---|
| `getControllerInfo` (`0xA3`) | `(type, 0, 237)` — the full table, one request |
| `getMeterInfo` (`0xA5`) | `(type, 0, 198)` — the full table, one request |
| `getSensorInfo` (`0xA7`) | `(type, 0, 164)` — the full table, one request |
| `getBatteryInfo` (`0xA4`) | `(type, 0, 200)`, then `(type, 200, 44)` — two requests |
| `getIotFunctionInfo` (a different, non-Bafang-branded IoT type) | `(type, 4, 153)` — non-zero offset |

Two things fall out of this. First, `getControllerInfo`'s single request for the full 237 bytes at
offset 0 is **exactly** the request that correlates with the fourth hardware run's bike going
unresponsive (§10) — this isn't a malformed or unusually aggressive request invented for testing,
it's the vendor's own app's ordinary way of reading this table. Whatever went wrong is a property
of ADO's specific firmware, not of asking for something the protocol wasn't meant to provide.

Second, `getBatteryInfo`'s two-request split (`0`+`200`, then `200`+`44`) and
`getIotFunctionInfo`'s `offset=4` both use non-zero offsets that are not 24-byte-aligned — `200`
isn't a multiple of 24, and neither is `4`. If ADO's firmware requires offsets to land on a 24-byte
field boundary, these wouldn't work there either; the reference implementation gives no reason to
expect alignment matters, only that ADO's specific hardware doesn't answer *some* non-zero offset
(§10 only tried one, `60`, itself unaligned).

### Cross-check against the actual ADO capture

The ADO app's `contorlCode` and `zpower` commands (spec §8, §13) are `meterRead(target, 0, 48)` calls
that nobody in the ADO app recognised as reading a *table* — they just wanted two version strings.
Re-reading the earlier hardware capture (see §10) against the reconstructed `BfControllerInfo` and
`BfBatteryInfo` layouts:

```
controller reply (48 of 237 bytes):
  bytes 0-23  "CR A101.C 1.1\0..."      == BfControllerInfo.hardVersion  (offset 0,  24B ASCII)
  bytes 24-47 "CRS20RC3615F8010..."     == BfControllerInfo.softVersion (offset 24, 24B ASCII)

battery reply (48 of 244 bytes):
  bytes 0-23  "C20018 0.2\0..."         == BfBatteryInfo.hardVersion
  bytes 24-47 "C20018 1.3\0..."         == BfBatteryInfo.softVersion
```

Exact match, at the exact offsets the reconstructed table predicts. This is what makes the spec's
§14 identity header (offsets 0–143) verified rather than merely plausible — it is confirmed against
real bytes from an ADO bike, not just against Bafang's own app. Everything from offset 144 onward
(the live values — power, voltages, currents, temperatures) is unconfirmed on ADO hardware
specifically: the ADO app never reads that far, so there is no capture to check it against. It
should work, on the strength of the identity-header match and of `contorlCode`/`zpower` being
ordinary `meterRead` calls against the same table, but the spec's §14 flags it as such.

### What this doesn't explain

Bafang Go talks to `0xA3` (controller), `0xA4` (battery) and, implicitly, the display — the
`DeviceTableAddress` constants match the spec's §3 node map exactly (`DeviceType_IOT_BF_CONTROLLER = 163 =
0xA3`, `DeviceType_IOT_BF_BATTERY = 164 = 0xA4`). But its device-type table has no equivalent for
`0xA7`, which the ADO app treats as a GPS tracker (`updateIot`, spec §11). `DeviceType_IOT_BF_Sensor = 167 = 0xA7` is the nearest match in Bafang's own numbering, and its
table (`BfSensorInfo`) is a torque-signal and cadence pair, not GPS — consistent with it being the
pedal-torque sensor rather than a tracker. One of the two apps is likely wrong about that node;
the spec's §14 flags it rather than picking a side.

### Turning it into something testable

Reconstructing the tables from source is one kind of confidence; reading them off an actual ADO
bike is another, and until that happens spec §14's live-value offsets are still "should work," not
"does work" (see §10). [`../webapp/index.html`](../webapp/index.html) was extended to close that
gap: four new checks that read the controller, battery, meter and `0xA7` tables in full and decode
them per the spec's §14, plus a cross-check comparing the controller table's own wheel-diameter and
speed-limit fields against the settings-block values already read earlier in the same session.

This needed request/response correlation the page didn't have. Every other check in it is
fire-and-forget — send a query, `sleep()`, let whatever comes back fall through a big
`if (p.src === …)` dispatcher. That works for one-shot queries but not for a 237-byte table that
has to come back in `CMD=0x01` chunks of ≤60 bytes each, addressed by offset, where each chunk's
reply has to be matched to the request that asked for it before the next chunk can be sent. The
fix is a small waiter registry keyed by `(src, sub)` — the node address and the echoed start
offset — checked in `handleFrame` *before* the existing dispatcher ever sees the frame, so a
table-chunk reply is consumed by its waiter and never reaches the generic handler at all.

That interception point is exactly where a new feature quietly breaks an old one: two of the four
new read targets, `0xA3` and `0xA4`, are the same nodes the existing `ver.controller`/`ver.battery`
checks already watch for the ADO app's own 48-byte version-string reads. Before trusting this
anywhere near a real bike:

- **The decoders** were checked field-by-field against synthetic buffers built straight from
  the spec's §14 offset table — 21 controller fields including the computed-power multiply, 14 battery
  fields including signed pack current and cell voltages, 2 sensor fields. All matched exactly.
- **The chunked read/reassembly** was run against a simulated bike that replies correctly per
  chunk: exact byte-for-byte reassembly of a 237-byte table from four chunks, and no waiter left
  registered afterwards.
- **Two failure modes** — a node that implements less than the full declared table length, and a
  node that never replies at all — were confirmed to degrade to a clean `WARN`/`FAIL` with the
  exact offset or a 2-second timeout, rather than hanging the rest of the run.
- **The interception itself** was checked both ways: the existing version-string handler still
  fires correctly when no table read is in flight, and a table-chunk reply is claimed exclusively
  by its waiter — never double-processed — when one is.

The same pass over the file caught two unrelated bugs: the page's header comment still gave serve
instructions from before the file moved from `docs/` to `webapp/`, and — this one worth flagging on
its own, since it's not housekeeping — the page's own trip-statistics decoder still split the
backlight byte into two nibbles, the exact interpretation §11 documents as an ADO app bug. The
verifier had been silently reproducing the bug it exists to catch; fixed to the plain-byte reading
now confirmed independently in §9's cross-check.

---

## 10. Validation against hardware

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

**Third run: 22 of 22 pre-existing checks still pass** — nothing regressed — **but all five new
device-table checks came back short**, and what came back is itself a finding.

| Request | Reply |
|---|---|
| `0xA3`, offset 0, 60 bytes wanted | **72 bytes** |
| `0xA4`, offset 0, 60 bytes wanted | **72 bytes** |
| `0xA5`, offset 0, 60 bytes wanted | **72 bytes** |
| `0xA7`, offset 0, 60 bytes wanted | **0 bytes** — a real reply, `LEN=0x00`, correct checksum |
| `0xA3`/`0xA4`/`0xA5`, offset 60, 60 bytes wanted | **no reply at all** |

Two things fall out of that:

**The requested length isn't honoured — it's rounded up.** 60 became 72 on all three nodes that
answered. That's consistent with every length seen on any of these nodes so far, including the
ADO app's own `contorlCode`/`zpower` reads: 24→24, 48→48, 60→72 — always the next multiple of 24.
Six 24-byte fields sit at the front of every table (§9's identity header), so this reads as the
node serving whole fields, not a byte-granular length. It could stop being a clean multiple-of-24
rule above 72 — that's untested.

**Offset 0 is the only offset that gets answered.** The follow-up request at offset 60 went out
and nothing came back — not a short reply, not an error, nothing — from `0xA3`, `0xA4` and `0xA5`
alike, each confirmed by a full 2-second window of silence on that node punctuated only by the
ongoing `0x10` status broadcasts. Contrast this with `0xF2`/`0xF3`, where `caninfo`'s `SUB=0x30`
read demonstrably works (§5) — so non-zero offsets are not broken protocol-wide, just on these
particular nodes. Whatever `com.omni.support.ble`'s generic `meterRead(offset, length)` model
assumes, ADO's firmware for these four nodes appears not to implement arbitrary pagination: reads
only start at the beginning, and the length says how many *fields*, not bytes, you're owed.

**`0xA7` is not silent — it's empty.** It answered in 88 ms with a well-formed, correctly
checksummed `CMD=0x04` frame carrying zero data bytes. That rules out "unaddressed / absent from
the bus," which is what a node with no hardware behind it would usually look like (compare the
first hardware run, where the secondary battery `0xB4` never answered at all). `0xA7` is present
and protocol-compliant; it just has nothing to report at offset 0, which is equally consistent
with "no torque sensor fitted on this bike" and "GPS tracker with no readable table" — it doesn't
distinguish the two candidacies from §9, though it does rule out the node being entirely fictional.

None of this was predictable from Bafang Go's source, which models `meterRead` as a generic
byte-range read with no hint that ADO's specific firmware would special-case offset 0 — the value
of running it, rather than trusting the SDK's own contract.

**Consequence for spec §14.** Its "read in 64-byte chunks from offset 0" guidance is now known
not to work on this hardware, and the offsets it lists past the identity header — the actual
power/voltage/current/temperature fields this whole line of investigation was for — remain
unreached. The one avenue this run didn't try: a *single* request for the whole declared table
length at offset 0. If the rounding rule has no ceiling, that request should return everything in
one frame; if 72 bytes is a hard per-node cap regardless of what's asked, it won't. The page was
changed to try exactly that, request full length before falling back to chunking, and to stop
conflating `0xA7`'s empty-but-valid reply with silence — both fixed for whenever the next run happens.

**Fourth run: the bike went unresponsive and had to be power-cycled.** All 22 pre-existing checks
passed again first. Then the page sent its new single-shot request — the full declared table
length at offset 0, the change made in response to the third run — starting with `0xA3`:

```
10:13:43.211  TX   read 0xa3 offset 0 len 237
10:13:44.852  RX   (last live status broadcast, SUB=0x01)
10:13:45.097  RX   (last live status broadcast, SUB=0x09)
10:13:45.213  —    timeout: 0xA3 never answered
10:13:45.215  TX   read 0xa4 offset 0 len 244     ← total silence from here on
10:13:47.217  —    timeout: 0xA4 never answered
10:13:49.228  —    timeout: 0xA5 never answered
10:13:49.235  TX   read 0xa7 offset 0 len 164
10:13:51.237  —    timeout: 0xA7 never answered
10:14:06.486  —    GATT disconnected
```

The bike kept broadcasting its routine status stream right up until 45.097 — 1.9 seconds after
the `0xA3` request went out — then stopped completely. Every subsequent request got total
silence, not just a timeout on that one node: no status broadcasts, nothing, for the rest of the
session. The break happens during the wait on the *first* request, not later — by the time the
page reached `0xA5`, the bike had already been dark for two seconds. It reads like the last
`0xA3` request is what did it, not `0xA5`, even though `0xA5` is where it would first become
visible on screen.

Before concluding that, the obvious alternative was checked and ruled unlikely: an auto-off timer
firing coincidentally. The settings block read earlier in this same session gives the auto-off
time as 10 minutes; the connection had been open for about 9 seconds. The last live telemetry
showed no fault code and a full battery reading. A 10-minute inactivity timer firing 9 seconds
into a session that was, from the bike's perspective, continuously busy servicing BLE requests,
lining up precisely with the first-ever 237-byte read this bike had received, would be a
substantial coincidence. Not impossible, but the request is the more likely cause.

This is now treated as a real hazard rather than an open question. The page was reverted to
requesting at most 60 bytes per read — the largest size sent without incident across two prior
sessions — and no longer attempts a non-zero offset or a full-table single shot at all. That
closes off the one avenue that might have reached the live-value fields this whole line of
investigation was for, and it stays closed until there is a safer way to test the boundary between
"answered" (confirmed at 60) and "took the bike down" (confirmed at 237) — a boundary nobody
should go looking for casually, on hardware someone rides.

**Fifth run, after reverting to the 60-byte ceiling: clean.** No shutdown, no unresponsiveness —
the four table reads completed in 380 ms total, each answered in under 100 ms, and the opt-in
navigation test ran afterwards without incident. This is as close to a controlled before/after as
this investigation gets: same bike, same session shape, the one variable changed being the
request size, and only the large one produced a problem.

The reply was identical in shape to the third run — `0xA3`/`0xA4`/`0xA5` each returned 72 bytes
for a 60-byte request, `0xA7` returned zero — which rules out flakiness on the bike's side as an
explanation for either result: this is a deterministic, repeatable response to a specific request
size, not noise.

It also confirmed something new: the identity header's third field, `model`, had never come back
non-empty before. `0xA5` gave `B02H`, matching the module firmware string read separately via
`code`/`newcode` (§8) — independent corroboration that the display module and the "module"
`newcode` reports on are the same physical part. `0xA3` and `0xA4`'s model fields stayed empty,
which now looks like it's genuinely blank on this hardware rather than an artifact of a short
read, since this run requested — and received padding for — the same 72 bytes on all three.

60 bytes is now confirmed safe on two separate occasions; 237 bytes is confirmed unsafe on one.
Nothing between the two has been tried, and per the warning above, nothing should be, without a
deliberate decision to risk it.

### On MTU

Web Bluetooth exposes no MTU control, so the test page cannot do what the app's `setBLEMTU(512)`
does, and a 30-byte status frame could in principle arrive split across notifications. In practice
Chrome on Android negotiated enough — a 105-byte NFC reply arrived in one notification and the
reassembly buffer never fired. It is still there, and reports if it is ever needed.

### Manual table read

At the time this was built, the automatic device-table checks only ever sent one shape of
request (offset 0, ≤60 bytes) — deliberately, after the fourth run. (They now also try the
offsets confirmed below; see "Automating the confirmed offsets" after the sixth run.) But the
danger evidence at the time was specific to
*length*, not *offset*: the one non-zero offset ever tried (`60`, on three nodes, §10 third run)
was silently ignored, not harmful, and Bafang Go's own reference app routinely uses non-zero,
non-24-aligned offsets on other tables without any documented issue (previous subsection). Offset
is the more promising, and so far the safer, direction to keep exploring — length above 60 is not.

The page grew a manual control for exactly this: pick a node, an offset and a length, see the
exact frame before sending it, send one request at a time, and get the raw bytes back (plus a
best-effort decode if the request started at offset 0 and targets a table in spec §14). It reuses
the same request/reply plumbing as the automatic checks, so it is bound by the same 2-second
per-request timeout, and it applies its own gate on top: any length over 60 requires an explicit
confirmation checkbox, and that checkbox clears itself on *any* edit to node, offset or length — it
was caught, in testing, not carrying over correctly between two different over-60 values entered
in succession, and fixed before this shipped. There is no equivalent friction on offset, because
there is no evidence yet that offset is the dangerous dimension.

The default values in the page (offset 24, length 24) are the smallest useful next experiment: an
aligned, non-zero offset, at a length nothing has ever had trouble with.

**Sixth run: manual, offset by offset, on the motor controller.** Six requests, tried in this
order, each a deliberate choice by a human rather than an automatic sweep:

| Request | Reply |
|---|---|
| offset 24, want 24 | **24 bytes, exact** |
| offset 48, want 24 | **24 bytes, exact** |
| offset 72, want 24 | **32 bytes** — more than asked, unlike anything at 24 or 48 |
| offset 144, want 24 | no reply |
| offset 160, want 24 | **24 bytes, exact** — the start of the live-value block |
| offset 160, want 128 | no reply, then the bike went unresponsive |
| offset 160, want 160 | sent 6.8 s *after* the GATT connection had already dropped — never reached the bike |

This overturns the third run's conclusion. "Only offset 0 answers" was one data point (offset
`60`) generalised too far. Every offset here that lines up with a real field boundary in spec
§14's own table — `24` (firmware version), `48` (model), `72` (serial number), `160` (battery
level, the first live field) — got an answer. The two that didn't, `60` (third run) and `144`
here, both fall in the middle of a field or on a gap the spec's own table already calls
"reserved" — not a real field, on either count. The cleanest explanation covering every offset
tried so far, across three sessions: **these nodes answer a read that starts exactly on a field
they recognise, and ignore one that doesn't**, which is a plain register-file model, the same one
established for the settings nodes in §5 — not "offset 0 only," and not a matter of 24-byte
alignment either, since 160 isn't a multiple of 24 and answered anyway.

`72`'s reply breaks the length model from the third run, though: that run found every short
request at offset 0 rounds up to the next multiple of 24 (`60`→`72`). Here, `24` bytes requested
at offset `24` and `48` came back as exactly `24` — no rounding at all — while the same `24`-byte
request at offset `72` came back as `32`. Whatever decides how much a request actually returns
isn't a single rule that's been fully characterised; it's at least offset-dependent, and this adds
a data point rather than resolving one.

**The offset-160 reply is the first live data this investigation has ever seen** — battery level,
trip distance, odometer, remaining range, cadence, torque signal, speed, motor current, battery
voltage, controller and motor temperature, and boost state, all in the 24 bytes requested:

| Field | Raw | Decoded |
|---|---|---|
| Battery level | `0x0064` | **100%** — matches the status report's own battery reading exactly, an independent cross-check that this offset is genuinely the field spec §14 says it is |
| Trip distance | `0x0000` | 0.00 km |
| Odometer | `0x0000` | 0.00 km |
| Remaining range | `0xFFFF` | 655.35 km literally, or an unpopulated-value sentinel — `0xFFFF` is a common one and this reads like it |
| Cadence | `0x0000` | 0 rpm |
| Torque sensor signal | `0x00EE` | 238 mV |
| Speed | `0x0000` | 0.00 km/h |
| Motor current | `0x0000` | 0.00 A |
| **Battery voltage** | `0x1022` | **41.30 V** — the first real voltage reading this whole investigation set out for |
| Controller temperature | `0x0014` | 20, minus 40 per spec §14 = -20°C, or 20°C unadjusted |
| Motor temperature | `0x0014` | same raw value as controller temperature, same ambiguity |

Speed, cadence and motor current all reading zero on a bike sitting still, and the battery
percentage matching the independently-read status report, is a good sign the decode is landed
correctly. The two temperature fields reading the identical raw value is the opposite kind of
sign — plausible if both sensors happened to read the same ambient temperature, suspicious as a
coincidence, and not something to trust without another reading. The spec's "subtract 40" scaling
would put both at a metrologically implausible -20°C; unadjusted, `20` reads as a physically
sensible 20°C. Which is right isn't settled by one sample.

**And the length danger boundary just moved.** The `want=128` request at offset `160` — a
non-zero offset this time, not the offset-0 pattern from the fourth run — correlates with the
same failure shape: routine status broadcasts stop within a few hundred milliseconds of the
request going out, and the GATT connection drops entirely about two seconds later. Same
non-explanations ruled out as before: no fault code, a full battery reading, a connection open
for barely over a minute against a 10-minute auto-off timer. The common factor across both
incidents isn't the offset — one was 0, this one was 160 — it's the length: both were
substantially larger than anything ever answered cleanly (72 bytes, at most). The unsafe lower
bound has now narrowed from "237, once" to "128, at a different offset, on a different day." What
happens between 73 and 127 bytes is still completely unknown, and — per the reasoning above —
that gap looks narrower and more worth leaving alone, not less.

### Automating the confirmed offsets

After the sixth run, the four offsets it tried on the controller — `24`, `48`, `72`, `160` — were
folded into the automatic checks, right after the existing offset-0 read. This isn't new risk: it
repeats four requests a human already sent, individually, without incident, instead of requiring
that to happen by hand every session. It only runs if the controller answered at offset 0 at all
in the first place — no point trying further offsets on a node that isn't there.

`24` and `48` are informationally redundant with what the offset-0 read already returns (it rounds
up to 72 bytes, covering the hardware version, firmware version and model in one go) — they're
kept anyway, mostly as an ongoing check that non-zero-offset support hasn't regressed. `72` and
`160` add data the offset-0 read can't reach: the rest of the serial number, and the live-value
block. The `160` reply is decoded field-by-field with the same "only show what was actually
covered" logic as the manual tool's decoder, rather than reusing the full-table decoder and
padding the untested remainder with zeros dressed up as data. The two temperature fields are
labelled with their raw value and both possible readings rather than picking one, matching the
ambiguity flagged above — this tool should not quietly resolve an open question by choosing a
formatting convention.

Length stays at 24 for all four, matching exactly what was tried. Nothing here reaches toward the
73–127 gap, and nothing here touches an offset that wasn't already confirmed by a human first.

**Seventh run: manual exploration past the automated offsets, ending in a third crash.** All 22
pre-existing checks and the new `tables.controllerExtra` automation passed cleanly first. Then a
session of hand-picked manual reads, in this order:

| Request | Reply |
|---|---|
| `0xA4`, offset 72, want 24 | **32 bytes** — battery also rounds up at offset 72, same as the controller (sixth run) |
| `0xA3`, offset 72, want 24 | 32 bytes, repeat of the sixth-run result |
| `0xA3`, offset 144, want 24 | no reply — benign, as in the sixth run; status broadcasts continued normally throughout the wait |
| `0xA3`, offset 160, want 24 | 24 bytes, exact — repeat of the sixth-run result |
| `0xA3`, offset 200, want 24 | no reply — **then the bike went unresponsive** |

`200` is a real field boundary — spec §14 lists it as "time since last speed-sensor pulse" — and
`24` bytes is a length already used without incident at four other offsets in this same session.
Neither "stick to field-aligned offsets" nor "stick to lengths that have already worked" would
have flagged this one.

The timing matches the fourth and sixth runs exactly:

```
11:15:37.387             TX   read 0xa3 offset 200 len 24
11:15:37.410  (+0.023s)  RX   last live status broadcast (SUB=0x09)     ← last traffic of any kind
11:15:39.387  (+1.975s)  —    timeout: no reply to the offset-200 read
11:15:41.279  (+1.892s)  —    GATT disconnected
```

The contrast with the same session's offset-144 request — also a "no reply" outcome, also 24
bytes — is what makes this a crash rather than just another unanswered offset: status broadcasts
kept arriving right through the full 2-second wait on `144`, and stopped dead within 23 ms of the
`200` request going out. "No reply to my read" and "the bike has gone quiet on everything" are
different events that happen to look the same in the request/reply log alone; only the background
broadcast stream tells them apart. Every crash so far — fourth run, sixth run, this one — shows the
same signature: broadcasts stop within tens to hundreds of milliseconds of the triggering request,
followed by a GATT disconnect one to two seconds later. A benign "no reply" never touches the
broadcast stream at all.

**This overturns the sixth run's working theory.** That run concluded offset was the safe
direction to explore and length the dangerous one, because the two crashes then on record (237
bytes at offset 0; 128 bytes at offset 160) had different offsets but both had a length well past
72, the largest anything had answered cleanly. This run's crash breaks that: 24 bytes had already
answered cleanly at 24, 48, 72 and 160 in the very same session, and still crashed the controller
at offset 200. Length isn't sufficient to explain it, and neither is field alignment — 200 is as
legitimate a field start as 160 by the spec's own table. There is no known-safe rule left, in
either dimension, only a single known-unsafe point: offset 200 on `0xA3`, specifically. Everything
else is genuinely untested, not confirmed-safe-by-pattern.

### The full table sweep

In response, and given the user's own assessment that these crashes are low-stakes — each one has
recovered with nothing worse than a controller restart — the page grew a broader, opt-in
exploration tool (§6 in the page) that walks all four nodes' tables, not just the controller's,
in 24-byte strides, and requests everything it can that isn't already covered elsewhere on the
page. It excludes exactly one thing outright: a request whose start offset is `200` on `0xA3`.
Nothing else is assumed safe just because it resembles something that was.

Since offset alone can now be the danger, the sweep cannot lean on "try a value, see if it works"
the way the manual tool could when only length looked risky. Instead it watches the *background*
status-broadcast stream, not just the reply to its own request: after every single request,
answered or not, it checks whether any frame at all has been seen in the last 1.5 seconds — about
five times the normal ~250-300 ms gap between broadcasts, comfortably wider than normal jitter but
much tighter than the 2-second read timeout, so a real crash is caught well before the sweep would
otherwise move on to its next request. If nothing has arrived, that's treated as the same signature
as all three crashes above, and the entire remaining sweep — every offset left on the current node,
and every node after it — stops immediately rather than continuing into whatever state the
controller is in.

**Eighth run: the sweep found a fourth crash, and this one narrows the cause.** Before running the
sweep, two manual 160-byte reads confirmed something new: `0xA4` and `0xA5` both answered a
single 160-byte request cleanly (162 and 160 bytes back respectively), where the equivalent
request to `0xA3` got no reply at all — and, checked against the broadcast stream the same way as
every other "no reply" in this document, that one was benign: status broadcasts continued right
through the full two-second wait. Whatever is dangerous about large single reads on `0xA3`, it
isn't dangerous on `0xA4` or `0xA5`, at least not at this length.

The sweep itself then ran against the controller: offsets 96 and 120 went unanswered (silently,
broadcasts continuing), offset 168 answered with 24 bytes, and offset 192 — the very next stride —
crashed it, with the same signature as every prior incident:

```
11:41:34.900  TX   read 0xa3 offset 168 len 24
11:41:34.986  RX   reply, 24 bytes, sub=0xa8 (168)
11:41:35.001  RX   last live status broadcast (SUB=0x01)
11:41:35.245  TX   read 0xa3 offset 192 len 24
11:41:35.287  RX   last live status broadcast (SUB=0x09)     ← last traffic of any kind
11:41:37.246  (+1.96s)  —  sweep's own quiet-broadcast check fires, aborts the rest of the sweep
11:41:39.141  (+1.90s)  —  GATT disconnected
```

**This is the finding that matters: offset 192 is not offset 200,** and the seventh run's fix —
refuse the exact start offset `200` — would have let this request straight through. What the two
crashes have in common is not the start offset, it's the *byte range touched*. A 24-byte read from
192 covers bytes 192–215, which reaches into 200–201; a 24-byte read from 168 covers 168–191, which
stops one byte short of 200 and was fine. Byte 200–201 — spec §14's "time since last speed-sensor
pulse" — now looks less like an ordinary table field and more like a hardware register with a read
side effect: a capture/counter peripheral that a periodic-broadcast firmware reads safely on its
own schedule, but which does something the firmware doesn't recover from when a bulk table read
touches it out of turn. That's a plausible mechanism, not a confirmed one — nothing here proves it
over any other explanation that happens to produce the same two data points — but it's specific
enough to test, and cheap to route around regardless of why it's true.

Two data points bracketing the same 2-byte window from both sides — 168–191 clean, 192–215 and
200–223 both bad — is a real convergence, not a coincidence to wave off. The danger model updates
accordingly: it is not "avoid offset 200," it is **"avoid any read whose range includes bytes
200–201 on `0xA3`."** Everything checked so far that stays clear of that window — including reads
starting well past it, like 168, and unrelated to it entirely, like the 160-byte reads on `0xA4`
and `0xA5` — has been fine.

### The dangerous range, generalised

The sweep tool (§6 in the page) was updated to check a request's *entire* byte range against known
hazards, not just its start offset. Each `SWEEP_TARGETS` entry now carries `dangerousRanges`, a
list of `[start, end)` byte ranges rather than a set of individual offsets; before sending any
request, the sweep checks whether `[offset, offset+length)` overlaps any of them, and skips it if
so — logged as `SKIP`, with the specific range it collided with, same as before. The controller's
entry is `[[200, 202]]`; the other three nodes have none, since nothing has crashed on them yet.
This is a strictly more conservative check than the previous exact-offset one: it catches
offset 192 (which the seventh-run fix missed) and would also catch, say, a hypothetical 40-byte
read from offset 180, without needing another hardware run to notice the new case by hand. The
manual-read section's warning text and offset hint were updated the same way — the message is now
"check whether your range overlaps 200–201," not "avoid offset 200."

This still is not a proof that nothing else on any of the four tables carries the same kind of
hazard — only that this one specific window does, confirmed twice, from both sides. The
quiet-broadcast abort check (previous subsection) remains the only defence against a hazard that
hasn't been found yet, on this or any other node, and the sweep still stops the entire remaining
run the moment it trips.

**Ninth run: the sweep completed on all four nodes without incident.** All 22 pre-existing checks
passed, `tables.controllerExtra` passed, and the sweep ran `0xA3` → `0xA4` → `0xA5` → `0xA7` to
completion — no abort, no disconnect. This is the first time the full sweep has finished clean,
and it produced far more live data than any run before it, alongside a few genuine gaps and two
findings that revise the spec.

*Coverage.* Per node, what answered on the 24-byte stride:

| Node | Answered | Silent (no reply, benign) |
|---|---|---|
| `0xA3` controller | 0, 24, 48, 72, 160, 168 | 96, 120, 216 |
| `0xA4` battery | 0, 24, 48, 72, 120, 144, 168, 240 | 96, 192, 216 |
| `0xA5` meter | 0, 24, 48, 72, 120, 168 | 96, 144, 192 |
| `0xA7` | 0 (zero bytes, as always) | 24, 48, 72, 96, 120, 144 — every single one |

Every "silent" entry was checked against the broadcast stream the same way as every prior
incident: broadcasts continued right through, so these are the benign kind — not a field the
firmware recognises, not a repeat of the offset-200-201 hazard. `0xA7` answering nothing at any
offset, having now been tried across essentially its whole table, is the strongest evidence yet
for "nothing implemented on this node" over "implemented but empty at this one offset" — it
doesn't settle the tracker-vs-sensor question from §9, but it does mean that question won't be
settled by reading further registers on this bike.

*Two findings that revise the spec, both cross-checked independently rather than taken on their
own:*

- **Wheel diameter (`0xA3` offset 186) is ×0.1 in, not ×1 in as spec §14 currently states —
  confirmed, not just likely.** The raw reading was `200`. Taken as documented that's 200 inches,
  absurd for a bicycle wheel; taken as 20.0 in it matches this bike's own model name, *Air 20Pro*.
  That alone would be circumstantial, but the same 24-byte reply also carried tyre circumference
  (offset 188), which came back `1595` mm — almost exactly `π × 20 in × 25.4 mm/in ≈ 1595.9 mm`.
  Two independently-read fields agreeing with each other and with the bike's name, under one
  scaling hypothesis and not the other, was already a real convergence from a single sample rather
  than two coincidences. It's since been confirmed a further two ways: the bike's wheel is
  directly known to be 20in, and the old sweep webapp's settings-block parser (which applies this
  same ×0.1 scale independently of the live-block reading discussed here) also showed 20.0in.

- **Battery pack voltage (`0xA4` offset 154) is ×0.1 V, not ×0.01 V as spec §14 currently
  states — confirmed, not just likely.** The raw reading was `413`. As documented that's 4.13 V —
  not a plausible pack voltage for an e-bike battery. As 41.3 V, it matches the controller's own,
  separately-read battery-voltage field (§10, sixth run: `41.30 V`) almost exactly. Same shape of
  evidence as the wheel diameter case: one raw number, two readings of what should be the same
  physical quantity, agreeing under one scaling and not the other. It's since been confirmed a
  further way, independent of any register cross-check: the pack is directly known to be a 37V
  nominal / ~42V full-charge pack (a standard 10S lithium-ion e-bike pack), and every voltage this
  dashboard has read back — low-to-mid 41V — sits exactly where that chemistry puts a
  mostly-to-fully charged pack, not 100x or 10x off in either direction.

*New identity data, previously blank.* The meter's serial number field (`0xA5` offset 72) came
back `938513864N00651` — the controller and battery's equivalent fields have always come back
empty, so this is the first confirmed non-empty serial on any node. The meter's manufacturer field
(within offset 120's reply) came back `ADO-EBIKE`, matching the device's own BLE advertised name.

*Cross-check.* The meter's auto-off-time field (`0xA5` offset 180) read `10` minutes, matching the
settings-block value read independently earlier in the same session (§10, fourth run's session had
the same figure) — another field landing exactly where the spec says it should.

*The `LEN` rounding rule needs another revision.* Every prior run's short replies rounded up to a
multiple of 24 (`60`→`72`, `24`→`32`). This run broke that twice: `0xA4` offset 168 requested 24
bytes and got **68** back, and `0xA5` offset 168 requested 24 and got **41** back — neither is a
multiple of 24. Both replies happen to stop right at a natural table boundary instead: the battery
one stops at byte 236, exactly where "maximum permitted charge voltage" begins; the meter one at
byte 209, one past the last field this document currently lists for that table. The rounding rule
looks less like "round up to 24" and more like "return everything from here to the next reserved
gap or declared field boundary" — consistent with the original register-file model, just not
bounded to multiples of 24 the way every earlier sample suggested.

*Two gaps closed in the tool, not on the bike.* The battery's offset-144 request had already been
returning real data every run since the seventh — full/remaining capacity, charge percentages,
pack current, pack voltage, pack temperature, charge/discharge flags, cell counts — none of it was
being decoded, because `BATTERY_SWEEP_FIELDS` only had entries starting at offset 168. That's a gap
in the sweep tool, not in the data actually available; it's fixed now, and this is where the
pack-voltage reading above came from. Separately, offsets 202 (controller) and 236 (battery) are
real field starts that the 24-byte stride can never land on by construction — the sweep grew a
small `extraChunks` list per node for exactly this, checked against `dangerousRanges` the same as
every other request: `0xA3` offset 202, length 35 (crank pulse counter through protocol version,
starting just past the 200-201 hazard and reaching to the end of the table in one request) and
`0xA4` offset 236, length 4 (maximum permitted charge voltage, the one battery field nothing has
reached yet). Between this and what the ninth run already covered, the controller and battery
tables are close to fully read; the next run is expected to close both remaining gaps.

**Tenth run: the offset-202 fix crashed the controller.** All 22 pre-existing checks passed, and
the sweep reached the controller's new `extraChunks` request — offset 202, length 35, the read
built specifically to start clear of the 200-201 hazard and pick up everything from the crank
pulse counter to the end of the table:

```
12:05:15.601  TX   read 0xa3 offset 168 len 24     ← answered normally, 24 bytes
12:05:18.057  RX   last live status broadcast (SUB=0x01)
12:05:18.226  TX   read 0xa3 offset 202 len 35
12:05:20.226  (+2.00s)  —  read timeout; sweep's quiet-broadcast check fires and aborts
12:05:22.115  (+1.89s)  —  GATT disconnected
```

Same signature as every prior incident: the last frame of any kind arrives before the triggering
request, then nothing, then a disconnect a couple of seconds later. The abort check did exactly
what it was built for — this was the first crash where the sweep itself, rather than a human
watching the log, recognised it had happened and stopped before touching `0xA4`, `0xA5` or `0xA7`.

**But the boundary the ninth run had settled on was still wrong.** Offset 202 sits two bytes past
`[200, 202)`, the range that was excluded at the time — it should have been safe by that model, and
wasn't. The user followed up with manual single reads after this run (not captured in a downloaded
JSON, so no timing log for these — reported directly): offsets up to 206 also crash the controller.
That points at a specific, checkable boundary: the controller's own field table lists four
consecutive 2-byte fields from 200 to 207 — time since last speed-sensor pulse (200), crank pulse
counter (202), motor gearbox total gears (204), motor gearbox current gear (206) — all of them
hardware counters or timers, as opposed to the plain configuration bytes on either side (wheel
data and calories before 200; cruise control, assist defaults, motor angle and acceleration
starting at 208). A block of four related hardware-counter registers behaving as one hazardous
unit, rather than one field in isolation, fits both the eighth run's overlap evidence and this
one's single-offset failure better than a 2-byte window ever did.

**This is the second time the exclusion list has been corrected upward, and it should be read as
still provisional, not fixed.** First a single offset; then a 2-byte range after the eighth run;
now 8 bytes after the tenth. The tool's `dangerousRanges` entry for the controller is `[200, 208)`
and its `extraChunks` entry now starts at `208` instead of `202` — chosen as the first offset past
the newly-widened window and the point where the field table's character changes from hardware
counters to configuration, not because 208 has itself been read yet. If it's wrong too, the
quiet-broadcast abort check — not the exclusion list — is what will catch it, exactly as it caught
offset 202 this time.

**Eleventh run: clean, and it answers the question the tenth run left open.** The sweep reached
the controller's new `extraChunks` entry — offset 208, length 29, the request rebuilt after the
tenth run to start right after the widened danger window — and got no reply. No crash either:
broadcasts continued normally, and the sweep went on to read `0xA4`, `0xA5` and `0xA7` without
incident, closing battery offset 236 (max charge voltage, all zero) along the way. So 208 is
confirmed *not* dangerous, but a 29-byte bundle starting there still isn't a real field boundary
by this firmware's own addressing, any more than offset 96 or 120 are.

That distinction — silently ignored versus actually implemented — prompted a different approach:
requesting each remaining field individually, at its own exact declared size, rather than one
oversized bundle covering several fields at once. Sixteen such reads were added:

- `0xA3`, thirteen reads covering every controller field from 192 to 236 not already read, each
  sized to that one field: 192, 194, 196, 198 (2 bytes each — current/total assist level, wheel
  speed, wheel revolution counter), then 208, 209, 210 (1 byte each), 211 (2 bytes, motor starting
  angle), 213 (1 byte, acceleration), 214 and 224 (10 bytes each, the per-level speed/current limit
  arrays), 234 and 236 (1 byte each, buzzer and protocol version). None overlap 200-207.
- `0xA5`, five reads covering 160-167 — the meter's own live-value block start (number of assist
  levels, sport mode, boost active, current assist level, backlight) — which has never been
  requested before now: it isn't a multiple of 24, so the stride sweep has always stepped past it,
  the same gap the controller had at offset 202/208 before those were added explicitly.
- `0xA7`, one 4-byte read at offset 160, covering both of the node's only documented fields
  (torque signal, cadence) in a single request — also never tried before, for the same reason.

This has not yet been run against hardware. If exact-sized requests succeed where the bundled
208-236 attempt didn't, the controller table will be essentially complete; if they still get
silence, that firmware genuinely doesn't expose these particular registers to a read command at
all, regardless of how the request is shaped, and the gap is a dead end rather than a request-size
problem.

Separately, [`../webapp/index.html`](../webapp/index.html) had its in-line documentation stripped
at this point — the header comment, the danger panels' explanatory prose, and the per-field
rationale comments accumulated over the previous ten runs. The safety logic itself
(`dangerousRanges`, the quiet-broadcast abort check, `covered`/`extraChunks`) is unchanged; only
the prose explaining *why* it's shaped that way is gone from the page, on the basis that this
document is where that history actually lives.

**Twelfth run: a fourth crash, and it overturns the mechanism, not just the boundary.** All 22
pre-existing checks passed, the stride reads through offset 168 answered normally, and the sweep
reached the first of the controller's newly-added exact-field reads — offset 192, length 2, just
the two bytes of "current assist level," nowhere near 200-201:

```
12:39:20.376  RX   last live status broadcast (SUB=0x09)
12:39:20.491  TX   read 0xa3 offset 192 len 2
12:39:22.493  (+2.00s)  —  read timeout; sweep's quiet-broadcast check fires and aborts
12:39:24.380  (+1.89s)  —  GATT disconnected
```

Same signature as all four prior crashes. But this one is qualitatively different from the
tenth run's: offset 202 at least started inside a range that reached toward the hazard on paper.
Offset 192 with a 2-byte length covers only bytes 192-193 — it cannot touch 200-201 under any
reading of "byte range." **This falsifies "a read's range overlapping 200-201/200-207" as the
actual mechanism.** The eighth run's offset-192, 24-byte crash was attributed to that request's
range reaching into 200-201; it's at least as likely, in hindsight, that offset 192 itself was
already enough on its own, and 200-201 had nothing to do with that particular crash. The two
explanations were indistinguishable until this run isolated them.

The user's own read of this — treating the danger zone as bytes 192-207, not 200-207 — is the
right conservative move and is what's now implemented (`dangerousRanges: [[192, 208]]`). It brackets
every point tried so far: 192 (crashes, this run, at length 2 — as minimal a request as any sent
in this whole investigation), 200 (crashes, seventh run), 202 (crashes, tenth run), 207 (implied by
206 crashing on manual testing after the seventh run), and 208 (does not crash, eleventh run,
tried as a 29-byte bundle). 194, 196 and 198 have not actually been tried in isolation — they were
pre-emptively withdrawn from the controller's `extraChunks` list on the strength of this bracket,
not because any of them has individually failed. That is the same kind of inference that
previously turned out to be wrong (assuming a field between two confirmed-bad points was itself
safe, or a range starting after a confirmed-bad point was clear), so treat 194/196/198 as
presumed-dangerous rather than confirmed-dangerous, and 208 onward as confirmed rather than
inferred, since it has actually been requested and answered with nothing but silence, not a crash.

Worth reconsidering given this: 192-207 covers current/total assist level (192, 194), wheel speed
and wheel revolution counter (196, 198), then the four counter/timer fields (200-206) already
implicated. Wheel speed, wheel revolution counter and time-since-last-pulse are plausibly the same
underlying speed-sensor hardware; assist level looks unrelated by function but could simply share
the same 16-byte hardware register page in the controller's address space regardless of what each
byte logically means. A single contiguous hazardous register block, rather than a cluster of
individually-poisonous fields, is a cleaner explanation of the data than either "byte range" or
"specific offsets" alone — but, as with every theory in this section so far, it's still inferred
from four data points, not verified by reading the whole block safely from the outside in.

This is the fourth time this boundary has had to widen. The pattern each time has been the same:
an estimate proposed after N-1 crashes turns out to still contain a point that crashes on request
N. There is no strong reason to expect 192-207 is the last word either — it should be read as the
best bracket the data supports right now, with the quiet-broadcast abort check, not the exclusion
list, doing the actual protective work, exactly as documented after the tenth run.

**Manual follow-up after the twelfth run: offset 196 is safe, offset 198 is not — the danger
window is not one contiguous block.** No downloaded JSON for this pair, reported directly rather
than captured; the pattern is clear enough not to need timing evidence. `0xA3` offset 196, length
2 ("wheel speed") answered without incident. `0xA3` offset 198, length 2 ("wheel revolution
counter") crashed the controller, same as everything else in this family.

This narrows the bracket rather than confirming it was ever one solid block: 192 (dangerous), 194
(untested), 196 (**safe**), 198 (dangerous), 200-207 (dangerous). The tenth/twelfth-run hypothesis
of "one hazardous hardware register page from 192 to 207" doesn't survive this — a safe register
sitting between two dangerous ones rules out a single contiguous cause tied to address range
alone. What's left standing is closer to the seventh-run idea, field by field: wheel revolution
counter (198), like time-since-last-pulse (200) and crank pulse counter (202), is a counter with
presumably a read side effect; wheel speed (196), like the ordinary settings fields either side of
this whole block, is an instantaneous computed value with none. Current/number of assist level
(192, 194) don't obviously fit that pattern by name, and 192 is confirmed dangerous regardless —
so either those two aren't what the field table says they are on this firmware, or the mechanism
isn't as clean as "counters bad, computed values fine" and something else about specifically
192 and 198 is shared that 196 doesn't share. Worth deciding with a reading at offset 194, which
remains the one byte pair in this stretch with no data point at all.

`dangerousRanges` for the controller is now `[[192, 194], [198, 208]]` — two precise exclusions
instead of one blanket range — and offset 196 has been added to the confirmed-safe `extraChunks`
list. 194 is deliberately in neither list: not requested automatically, not marked dangerous
either, since there's no evidence either way and guessing safe has been wrong before.

Separately, 196 came back `0` despite the wheel turning during the test. The spec's §14 has "wheel
speed" at this offset from the Bafang Go cross-reference alone, never independently verified
against a moving wheel until now, and a `0` while moving is either a scale/units problem (the
value exists but needs more motion, or averaging time, than a brief manual spin provides), a wrong
field identity for this offset, or a field this firmware simply doesn't populate over BLE. Not
resolved — see spec §14's caveats for the same field.

**Thirteenth run: the first crash on a node other than the controller — and it lands on the same
field name.** All 22 pre-existing checks passed, the controller's exact-field reads all completed
(196 answered, 208 onward all silent-but-benign, same as the eleventh run), and the sweep moved on
to the meter. Offsets 160 and 162 answered; 163 got a benign no-reply, broadcasts continuing
normally through the full wait; then offset 164, length 2 — "current assist level" — crashed it:

```
13:02:01.873  RX   last live status broadcast (SUB=0x01)
13:02:01.939  TX   read 0xa5 offset 164 len 2
13:02:03.942  (+2.00s)  —  read timeout; sweep's quiet-broadcast check fires and aborts
13:02:05.830  (+1.89s)  —  GATT disconnected
```

Same signature as every controller crash: last frame before the request, then nothing, then a
disconnect a couple of seconds later. The abort check worked exactly as designed, stopping before
`0xA7` was ever touched.

Worth being precise about what this run rules out, now that the target wasn't `0xA3`: it can't be
a bug specific to the controller's own firmware, since this request never went near it. Every
crash so far, on any node, is consistent with something on the shared internal bus locking up
regardless of which node's read exposed it — "crashes the controller" in the rest of this
document, for entries before this run, was shorthand for "the whole bike goes unresponsive," not a
claim about which physical part actually fails. The spec's §14 caveats now say the same thing.

The name is the interesting part. `0xA3` offset 192 — also "current assist level," also a 2-byte
field, also confirmed dangerous on its own with no length involved — is the controller's copy of
what looks like the same logical value. Two different nodes, two different tables, one shared
field name, both dangerous. That's a real pattern, not a coincidence to wave off: whatever makes
"current assist level" unsafe to read plausibly isn't about a specific memory address on one chip,
but about the value itself, or how it's computed, being something this protocol's read path
mishandles wherever it's exposed. Worth testing case for a hypothesis in a future run: read
"number of assist levels" (160/A5, 194/A3 — both already confirmed safe on their respective
nodes) alongside "current assist level" (164/A5, 192/A3 — both dangerous) as a paired comparison,
since the two are adjacent fields on both tables and only one of the pair fails.

The user's manual follow-up after this run, reading a few offsets above 164 by hand, found them
fine — consistent with the danger being confined to 164-165 specifically rather than spreading
into 166 (backlight) or beyond, the same narrow-window shape the controller's 192 turned out to
have. `dangerousRanges` for `0xA5` is now `[[164, 166]]`, and 164 has been withdrawn from its
`extraChunks` list; 166 stays, since it and 168 onward were already independently read without
incident before this run (§10, ninth run) and again confirmed just now.

**Fourteenth run: clean, full sweep, and it closes two open questions rather than opening new
ones.** All four nodes completed without incident, including every remaining `extraChunks` entry.
Two results are negative but useful; two are positive and strengthen existing findings.

*The controller's offsets 208-236 are a dead end for this read command, not an unanswered
question.* All nine exact-sized single-field reads added after the eleventh run — 208 through 236,
covering cruise control, assist defaults, motor starting angle, acceleration, both per-level limit
arrays, buzzer and protocol version — got no reply, exactly as the eleventh run's single 29-byte
bundle did. Two different request shapes, tried across two separate runs, both getting nothing,
is enough to stop treating this as "maybe the request shape was wrong" and start treating it as
"this firmware doesn't expose these registers to a read at all, regardless of how they're asked
for." These nine reads have been removed from `extraChunks` — they were costing about two seconds
of guaranteed timeout each, eighteen seconds a run, for data that was never coming back.

*`0xA7` offset 160 (torque signal and cadence together, the only two fields spec §14 documents
for this node) also got no reply.* Combined with every other offset tried on this node across
several runs — nothing past offset 0 has ever answered — this is now the strongest evidence yet
for "nothing implemented on this node on this bike" over "implemented but oddly addressed." The
`extraChunks` entry for `0xA7` has been removed for the same reason as the controller's: repeating
a request that has never once answered doesn't buy anything.

*Battery pack voltage's `×0.1 V` scaling is now confirmed twice, not once, and by a stronger kind
of evidence than the first time.* The raw reading was `412` this run, `413` last time — the
underlying value moved slightly, as a resting battery's voltage does between sessions, and the
scaled result (`41.2 V`) still matched the controller's own, independently-read battery-voltage
field (`41.20 V` this run) almost exactly, same as before (`41.3 V` against `41.30 V`). A static
value matching twice could be coincidence; a value that changed between reads and still matched
its independent cross-check both times is a considerably stronger signal. The spec's §14 treats this as
settled rather than merely likely now.

*The two controller temperature fields read the identical raw value a third time* (`20`, same as
every prior sample) — still doesn't resolve which scaling is correct, just repeats the ambiguity.
Meter's remaining live fields also came back plausible: 5 assist levels, backlight level 3
(matching the value already seen via the settings block and CAN registers elsewhere in this
document), sport mode 0. Offset 163 ("boost active") continues to get no reply on its own, for the
second run in a row, despite the rounded-up reply from offset 162 appearing to carry a value in
the position offset 163 would occupy — an artifact worth remembering rather than acting on, since
a direct read of that byte still hasn't succeeded.

**The odometer reset, and when it actually happened.** After the fourteenth run the user noticed
the bike's odometer, previously around 10-11 (miles, on the bike's own display — 17.61 km, the
BLE-decoded figure, converts to 10.94 mi), had gone back to 0. The live status broadcast's own
odometer field (spec §7, `SUB=0x01`, independent of every read this page ever sends deliberately)
is in every downloaded session. `ado-protocol-test.json` (first run) and `ado-protocol-test-2.json`
(second run, the next day) both read `17.61 km` throughout. A first pass at this account, made
before `ado-protocol-test-3.json` had been recovered, said the reset predated all exploratory
testing and that nothing here caused it. That was wrong — or at least said with more confidence
than the evidence supported. With `test-3.json` restored, the reset is captured live, and the
picture is messier than "before" and "after":

`test-3.json` (~10:08-10:11, between the second run and what's numbered the fourth) is an earlier
attempt at what would later become the fourth run — it sends the same unbounded reads,
`read 0xA3/0xA4/0xA5/0xA7 offset 0` at each table's full declared length, before the page was
changed to cap requests at 60 bytes. Three separate GATT connections happen inside this one
session:

- **Connection 1** (10:09:26–10:09:44): normal queries, then all four full-length reads in a row.
  None get a reply — but status broadcasts continue right through every one of them, the same
  "silently ignored" pattern as any other unanswered offset, not a crash. Odometer stays `17.61`.
- *(the page reloads — a fresh `self-test passed` at 10:10:09 — and the user reconnects)*
- **Connection 2** (10:10:14.238–10:10:15.717): under 1.5 seconds long. Only ordinary,
  long-since-proven-safe queries were sent — identification, auth, `code`, `newcode` — nothing
  resembling a dangerous read. It disconnects anyway, for a reason the log doesn't explain.
- **Connection 3** (10:10:21.874 onward): reconnects cleanly. Its very first status broadcast, at
  10:10:24.337, already reads `0.00 km`. The reset happened sometime in the roughly nine seconds
  between connection 2 dying and connection 3's first frame — a window with no BLE traffic at all,
  since the link was down. Later in this same connection, a repeat of the full 237-byte `0xA3`
  read does show the now-familiar crash signature (broadcasts stop right after it, silence, then
  `GATT disconnected` about eighteen seconds later) — but that happens *after* the odometer had
  already reset, so it's a separate event, not the cause.

So: nothing was on the wire at the exact moment the odometer changed, which does rule out a read
request doing it in the direct, mechanical sense. But connection 1's four full-length reads,
sent for the first time ever in this investigation about thirty seconds before things started
going wrong, cannot be cleanly ruled out either — none of them got the tight, immediate reply that
every *confirmed* crash in this document shows, but a slower-fuse consequence (something left in a
bad state that manifested as connection instability half a minute later) is not contradicted by
anything here, just not proven by it. The honest position is genuine uncertainty, not the clean
exoneration the first pass at this claimed: it might have been those reads with a longer fuse than
the ~2-second pattern this document otherwise relies on, it might have been ordinary BLE
instability around the page reload and reconnects, or it might have been something entirely
unrelated to this tool — including, plausibly, the official app's own "clear odometer" control,
which §11 below notes is gated only by a client-side PIN with no protocol-level authentication at
all. Nothing in the surviving log distinguishes between these.

## 11. Bugs in the official app

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

## 12. Still unknown

| | |
|---|---|
| ADS register layout | Registers above `0x0D` on `0xF2` have never been seen on the wire; the layout rests on the read encoding alone. Needs a bike with an ADS controller |
| Device table live values | Controller offsets 160-191 and 196 are read (196 reads `0` at rest and while moving — unconfirmed, see below); 192-193 and 198-207 are the confirmed hazard, permanently excluded; 194 is untested, deliberately neither read nor excluded; 208-236 was tried as nine exact-sized single-field reads and got no reply from any of them (§10, fourteenth run) — not dangerous, but not reachable via this command either, and no longer requested. Battery is fully read, including offset 236 (max charge voltage: zero); pack voltage's ×0.1V scaling is now confirmed twice, cross-checking the controller's own reading both times despite the underlying value moving slightly between sessions. `0xA5` has 160-163 and 166-208 read; 164-165 ("current assist level") is the confirmed hazard on this node too, permanently excluded; `0xA7` has offset 160 tried (both documented fields) and got no reply, consistent with every other offset on this node. Battery level, controller voltage and the meter's auto-off time all cross-check against independent readings; the two controller temperature fields (now three identical samples, still unresolved), wheel speed at 196, and the cell-voltage array (currently all zero) remain unconfirmed |
| Controller temperature fields | All three samples taken read the identical raw value between the two fields. Either a real coincidence three times over, or these two fields aren't laid out the way spec §14 currently states — the former looks decreasingly likely without actually being ruled out. Needs a reading where they *differ* to settle it — see §10, sixth/ninth/fourteenth runs |
| Which offsets are actually safe to read | Not a single contiguous window on `0xA3`: 192 and 198-207 are individually confirmed dangerous, 196 sitting between them is confirmed safe, and 194 has no data point either way. `0xA5` has its own, separate hazard at 164-165, with 163 and 166 confirmed safe either side of it — a much narrower, single-field window, unlike `0xA3`'s. Both dangerous fields (192/A3, 164/A5) share the name "current assist level" (§10, thirteenth run), which is either a real clue about the mechanism or a coincidence of which fields happened to get tested first — not yet distinguished. "Byte range overlap" and "one hazardous register page" have both been tried and disproven on `0xA3` (§10, seventh/eighth/tenth/twelfth runs); no equivalent theory has been tested on `0xA5` yet, since only one dangerous field is known there. `0xA4` and `0xA7` remain crash-free so far — large single reads (up to 68 bytes) have been clean on `0xA4`, and the sweep has reached all four nodes at least once, but that is not proof no equivalent hazard exists on either |
| Node `0xA7` | Confirmed present and protocol-compliant (§10), but answers offset 0 with zero bytes, and every other offset tried across its whole table — including offset 160, both of the node's own documented fields, torque signal and cadence, in the fourteenth run — gets no reply at all. Fits either candidacy from §9, tracker or sensor, but now strongly suggests nothing is implemented on this node on this bike at all, rather than an addressing mismatch. Still not conclusively resolved, but there's little left to try that would resolve it |
| Customer number field width | Corrected `0xA5`'s manufacturer field from offset 128 to 136 (confirmed against three separate captures — see spec §14) leaves an unexplained 8-byte gap after customer number's documented end at offset 127. Either customer number is 24 bytes wide, not 16, or there's a genuine reserved gap — nothing has ever populated customer number to test against |
| Card deletion | The exact payload, since the app's version is malformed and testing means losing a card |
| Battery byte, bit 7 | The app calls it `online`, but a full, plainly-connected battery reported it clear — confirmed a second time via the dashboard's own live telemetry (not just the sweep tool), sitting at 0% (offline) throughout a session with a 100%, fully responsive battery. The dashboard's B02H profile now ignores this bit entirely rather than surface it as a status indicator. What it actually signals, if anything, remains unknown |
| Capability report | Offsets 13–32 of the 26-byte reply |
| Live status | Offset 10, consistently `0x01` |
| Trip statistics | Offsets 15, 17–18 and 22 match controller settings exactly, but from one sample — could be coincidence |
| Bafang registers | `0x0D`–`0x2F` read as zero and are unnamed |
| Working mode, riding mode, drive mode, distance setting, battery display type | Named by the vendor but their value spaces are undocumented |
| `0x20`–`0x23`, `0x30`–`0x35` commands | Declared in Bafang's SDK (certification, navigation map/font update, a second-gen upgrade flow) but never sent by the ADO app — see §9 |
