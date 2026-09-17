# ADO e-bike Bluetooth Low Energy protocol

How to talk to an ADO e-bike over BLE: read live ride data, read and change controller settings,
push turn-by-turn navigation to the display, and update firmware.

The bike exposes a Nordic UART Service and speaks a small packet protocol over it. Internally it
is a bus of several nodes — display module, motor controller, battery, NFC reader — and every
packet is addressed to one of them, so the phone is really talking through the BLE module to
whichever subsystem it wants.

This document specifies the protocol. [`ado_protocol.py`](./ado_protocol.py) is a runnable
implementation of all of it.

Everything here was derived by reverse-engineering the official Android app and confirmed against
an ADO Air 20Pro; [`reverse-engineering.md`](./reverse-engineering.md) records how, and what is
still unknown.

## Contents

1. [Transport](#1-transport)
2. [Frame format](#2-frame-format)
3. [Node addresses](#3-node-addresses)
4. [Commands](#4-commands)
5. [Authentication](#5-authentication)
6. [Data types](#6-data-types)
7. [Status reports](#7-status-reports)
8. [Device information](#8-device-information)
9. [Settings](#9-settings)
10. [Navigation](#10-navigation)
11. [Lights, clock and other commands](#11-lights-clock-and-other-commands)
12. [Firmware update](#12-firmware-update)
13. [Command reference](#13-command-reference)
14. [Device information tables](#14-device-information-tables)

---

## 1. Transport

### Finding the bike

The bike advertises a name containing `ADO` — an Air 20Pro advertises `ADO-EBIKE`. Match on the
substring rather than a prefix if you can; the official app is case-insensitive about it.

The advertisement also lists the standard HID service UUID
`00001812-0000-1000-8000-00805F9B34FB`, and carries the bike's MAC address in its payload.

### GATT

| Role                   | UUID                                   |
| ---------------------- | -------------------------------------- |
| Service                | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| Write — phone to bike  | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` |
| Notify — bike to phone | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` |

This is the Nordic UART Service with its conventional RX/TX roles. The write characteristic
supports both `write` and `write without response`.

### Connecting

Connect, discover the service, subscribe to notifications on the notify characteristic, then
authenticate (§5). Nothing else works before the handshake completes.

Raise the ATT MTU if your platform lets you — the official app asks for 512. Frames run up to 105
bytes for an NFC card list and 135 bytes for a firmware chunk, so the default 23-byte MTU will
fragment them. The protocol has no fragmentation or reassembly of its own: one notification is
expected to carry one whole frame. If you cannot control the MTU (Web Bluetooth, for instance),
buffer received bytes and split on frame boundaries using the length field.

Serialise your writes. The bike does not cope well with overlapping requests.

### Liveness

There is no ping or keepalive frame. Once authenticated the bike pushes status reports
continuously at roughly 2 Hz without being asked, so silence is the signal that something is
wrong — the official app gives up after about 8 seconds of no traffic.

---

## 2. Frame format

Every frame, in both directions:

```
 0    1    2     3     4     5     6      7 .. 7+LEN-1    +2
+----+----+-----+-----+-----+-----+------+---------------+--------+
|0x55|0xAA| LEN | SRC | DST | CMD | SUB  |   DATA[LEN]   | CRC16  |
+----+----+-----+-----+-----+-----+------+---------------+--------+
```

| Field   | Size  | Meaning                                                                            |
| ------- | ----- | ---------------------------------------------------------------------------------- |
| Magic   | 2     | Always `55 AA`                                                                     |
| `LEN`   | 1     | Length of `DATA` only — excludes the header, `SUB` and the checksum                |
| `SRC`   | 1     | Source node address (§3). `0x11` is the phone                                      |
| `DST`   | 1     | Destination node address                                                           |
| `CMD`   | 1     | Command (§4)                                                                       |
| `SUB`   | 1     | Sub-command. Usually a register address; for streaming commands a sequence counter |
| `DATA`  | `LEN` | Payload                                                                            |
| `CRC16` | 2     | Checksum, little-endian                                                            |

So a frame is always `LEN + 9` bytes long, and `DATA` always starts at offset 7.

Multi-byte values are **little-endian** throughout, both in payloads and in the checksum.

### Checksum

A 16-bit one's complement of the byte sum, little-endian, computed over everything between the
magic and the checksum — that is, `LEN` through the final `DATA` byte:

```python
def checksum(payload: bytes) -> bytes:
    v = (~sum(payload)) & 0xFFFF
    return bytes([v & 0xFF, (v >> 8) & 0xFF])
```

| Payload                  | Checksum |
| ------------------------ | -------- |
| `011110010004`           | `d8 ff`  |
| `0611A70300112233445566` | `d9 fd`  |
| `0111F1010101`           | `f9 fe`  |

---

## 3. Node addresses

| Address | Node                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------- |
| `0x11`  | The phone. `SRC` of everything you send, `DST` of every reply                                  |
| `0x10`  | BLE / main control module. Handles authentication and the clock, and originates status reports |
| `0xA5`  | Display module. Lights, display units, backlight, module firmware version                      |
| `0xA3`  | Motor controller                                                                               |
| `0xA4`  | Main battery BMS                                                                               |
| `0xB4`  | Secondary battery BMS                                                                          |
| `0xA7`  | GPS tracker                                                                                    |
| `0xA9`  | NFC card reader                                                                                |
| `0xF1`  | Protocol/navigation endpoint. Navigation, language list, capability report                     |
| `0xF2`  | Controller settings, ADS family (UART controllers)                                             |
| `0xF3`  | Controller settings, Bafang family (CAN controllers)                                           |

A given bike has one controller family, not both: it answers on either `0xF2` or `0xF3` and
ignores the other completely. Probe both and use whichever replies. The Air 20Pro tested is a
Bafang bike and never answered anything sent to `0xF2`.

Queries to an absent node are silently dropped — a bike with no secondary battery simply never
replies to `0xB4`.

---

## 4. Commands

| `CMD`  | Direction | Meaning                                                                                          |
| ------ | --------- | ------------------------------------------------------------------------------------------------ |
| `0x01` | to bike   | **Read.** `SUB` is the first register, `DATA[0]` the number of bytes wanted                      |
| `0x02` | to bike   | **Write register.** `SUB` is the register, `DATA` the new value                                  |
| `0x03` | to bike   | **Action** — navigation, factory reset, light and unit toggles                                   |
| `0x04` | from bike | **Read reply.** `SUB` echoes the request, `LEN` is the number of bytes returned                  |
| `0x05` | from bike | **Write acknowledgement.** `DATA[0]` is `0x00` for success                                       |
| `0x06` | both      | **Monitor.** Same arguments as a read; the bike then streams that register range repeatedly (§7) |
| `0x07` | to bike   | Firmware update — begin (§12)                                                                    |
| `0x08` | to bike   | Firmware update — data chunk                                                                     |
| `0x09` | to bike   | Firmware update — verify                                                                         |
| `0x0A` | to bike   | Device reset                                                                                     |
| `0x0B` | from bike | Firmware update — chunk acknowledgement                                                          |
| `0x0C` | to bike   | Firmware update — cancel                                                                         |
| `0x20` | both      | Authentication (§5)                                                                              |

These further commands exist in the module family but the ADO app never sends them, so they are
untested on an ADO bike: `0x21` event notification, `0x22` navigation map update, `0x23` navigation
font update, and a second-generation firmware update flow on `0x30`, `0x32`, `0x33`, `0x34` and
`0x35`. All take the same `(target, register, payload)` shape.

### Reading

Most of the bike's state is a flat register file per node, read in blocks. A read asks for a
length and gets exactly that many bytes back:

```
read 48 bytes from register 0x00 of the motor controller
  ->  55 AA 01 11 A3 01 00 30 <CRC>
                  ^^ ^^ ^^ ^^
                 DST  |  |  count
                     CMD  first register

reply: 55 AA 30 A3 11 04 00 <48 bytes> <CRC>
```

In a reply, **`DATA[i]` is register `SUB + i`**. Two reads of the same node that overlap therefore
return identical bytes for the registers they share.

The `0xF1` endpoint is the exception: it ignores the requested length and sizes its own replies.

### Writing

A write names one register and carries its new value, whose width depends on the register:

```
set wheel diameter (register 0x30) to 20.0 inches on a Bafang controller
  ->  55 AA 02 11 F3 02 30 C8 00 <CRC>
```

The bike answers with `CMD=0x05`; `DATA[0] == 0x00` means it took effect. Re-read the block to
confirm.

---

## 5. Authentication

A fixed-key challenge/response, run immediately after subscribing to notifications. The bike
serves nothing until it completes.

```
phone -> bike :  55 AA 01 11 10 01 00 04 D8 FF          fixed, send verbatim
bike  -> phone:  55 AA LEN 10 11 04 00 <challenge>      CRC
phone -> bike :  55 AA 10 11 10 20 00 <16-byte block>   CRC
bike  -> phone:  55 AA 01 10 11 20 00 00                CRC   -> authenticated
```

1. **Send the identification frame** exactly as given above. It is a constant, checksum included.
   Retransmit every second until the bike answers.

2. **Receive the challenge.** It arrives as an ordinary read reply, `CMD=0x04, SUB=0x00`.
   Recognise it as "`SUB` is `0x00` and `CMD` is not `0x20`".

   **The challenge is short — 4 bytes in practice**, not a full cipher block. Do not assume 16.

3. **Reply with the encrypted challenge.** Zero-pad the challenge on the right to 16 bytes, then
   encrypt one block:

   |           |                                                               |
   | --------- | ------------------------------------------------------------- |
   | Algorithm | AES-128-ECB, no padding, a single block                       |
   | Key       | `32435444553430714E794367546A6231` (ASCII `2CTDU40qNyCgTjb1`) |

   Send the 16-byte ciphertext as `DATA` with `DST=0x10, CMD=0x20, SUB=0x00`.

4. **Check for acceptance** — `CMD=0x20, SUB=0x00`, with `DATA[0] == 0x00`.

The key is the same on every bike, so this authenticates the app, not the user. Anyone in radio
range can complete it.

| Challenge                          | Response block                     |
| ---------------------------------- | ---------------------------------- |
| `3c0af6cf`                         | `99115f40211f1dfcf1b5a62ee4959c79` |
| `00112233445566778899aabbccddeeff` | `67d228ce5f51bb500fe42c9a436d2ee8` |
| `0102030405060708`                 | `dcd8b6f7315c7f913bc71e1f201ca7a6` |
| all zeroes                         | `a5b52716179cba86962294f2a4574994` |

If your crypto library has no ECB mode — WebCrypto, for instance — AES-CBC with an all-zero IV
gives the same result for a single block; take the first 16 bytes of the output.

---

## 6. Data types

| Type             | Encoding                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Integer          | Unsigned little-endian, 1–4 bytes                                                         |
| Scaled value     | Little-endian integer at ten times the real value: wheel diameter `C8 00` = 200 = 20.0 in |
| Distance         | Integer in units of 0.01 km                                                               |
| Speed            | Integer in units of 0.1 km/h, except average speed which is 0.01 km/h                     |
| Battery level    | One byte. Low 7 bits are a percentage; bit 7's meaning is unknown                         |
| Battery selector | Bits 3:2 of a byte, as a 2-bit number                                                     |
| Text             | ASCII, `NUL`-terminated, zero-padded to the field width                                   |
| Enumeration      | One byte holding a single decimal digit, so values `0`–`9` only                           |
| Password         | 4 bytes, one decimal digit per byte                                                       |

Scaled values are always two bytes; plain enumerations and small counts are one. The width is a
property of the register — wheel diameter and undervoltage cut-off are scaled 16-bit, while
sensitivity and current limit are plain bytes.

---

## 7. Status reports

Once authenticated the bike pushes two report types unprompted, both from `SRC=0x10` with
`CMD=0x06`, at roughly 2 Hz. `SUB` distinguishes them. Offsets below are **absolute frame
offsets**, so `DATA` begins at 7.

`CMD=0x06` is a **monitor**: it takes the same `(target, register, length)` arguments as a read,
and the bike then streams that range repeatedly instead of answering once. The two reports below
are register blocks `0x01` and `0x09` of the module itself (`0x10`), which it streams without being
asked. Sending your own `0x06` to subscribe to a different range is plausible but untested.

### `SUB=0x01` — live status

| Offset | Size | Field                        |
| ------ | ---- | ---------------------------- |
| 7      | 1    | Fault code, `0` when healthy |
| 8      | 1    | Secondary battery level      |
| 9      | 1    | Battery selector             |
| 10     | 1    | Unknown, observed `0x01`     |
| 11     | 1    | Headlight, `1` = on          |
| 12     | 1    | Current assist level         |
| 13     | 1    | Number of assist levels      |
| 14     | 1    | Main battery level           |
| 15     | 1    | Working mode                 |
| 16     | 2    | Speed, 0.1 km/h              |
| 18     | 4    | Trip distance, 0.01 km       |
| 22     | 4    | Odometer, 0.01 km            |
| 26     | 2    | Calories                     |

`LEN` is 21.

### `SUB=0x09` — trip statistics

| Offset | Size | Field                                                     |
| ------ | ---- | --------------------------------------------------------- |
| 7      | 4    | Ride duration, seconds                                    |
| 11     | 2    | Average speed, 0.01 km/h                                  |
| 13     | 2    | Maximum speed, 0.1 km/h                                   |
| 15     | 1    | Wheel diameter, scaled — mirrors the controller setting   |
| 17     | 2    | Speed limit × 10, scaled — mirrors the controller setting |
| 19     | 1    | Backlight level                                           |
| 20     | 1    | Display unit, `0` = km, `1` = miles                       |
| 22     | 1    | Assist level — mirrors the controller setting             |
| 23     | 4    | Total ride time, seconds                                  |

`LEN` is 20. The three mirrored fields at 15, 17 and 22 match the corresponding controller
registers exactly on the bike tested, but that is a correlation from a single sample rather than a
confirmed meaning.

---

## 8. Device information

### Firmware versions

| Query                     | Reply                                    | Payload               |
| ------------------------- | ---------------------------------------- | --------------------- |
| `55 AA 01 11 A5 01 18 18` | `SRC=0xA5, CMD=0x04, SUB=0x18`, `LEN=24` | Module version, ASCII |
| `55 AA 01 11 A3 01 00 30` | `SRC=0xA3, CMD=0x04, SUB=0x00`, `LEN=48` | Motor controller      |
| `55 AA 01 11 A4 01 00 30` | `SRC=0xA4, …`                            | Main battery          |
| `55 AA 01 11 B4 01 00 30` | `SRC=0xB4, …`                            | Secondary battery     |

The module reply is a single ASCII string, e.g. `B02H_C_ADS_IOT02_BF_N11`.

The three 48-byte replies are **two 24-byte ASCII strings**: hardware revision first, then
firmware version. An Air 20Pro's motor controller returns `CR A101.C 1.1` and
`CRS20RC3615F801026.4`.

### Capability report

`55 AA 01 11 F1 01 01 01` asks the protocol endpoint what the bike is made of. The reply is
`SRC=0xF1, CMD=0x04, SUB=0x01` with `LEN=26`:

| Offset | Meaning                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 7      | Low nibble: protocol variant. Selects which controller family is fitted                                 |
| 11     | Feature bitmap — bit 7 main battery, bit 6 secondary battery, bit 2 GPS tracker, bit 0 motor controller |
| 12     | Low nibble: number of NFC card slots; `0` means no reader                                               |

Observed on an Air 20Pro:

```
02 00 56 05 87 02 0a a8 87 8b 07 40 14 64 00 2c 01 01 02 32 00 f4 01 01 09 3c
^^          ^^ ^^
variant 2   |  2 card slots
            bitmap 0x87 = main battery, no secondary, tracker, controller
```

Offsets 13 onwards are unidentified.

### Language list

`55 AA 01 11 F1 01 04 01` returns `SRC=0xF1, CMD=0x04, SUB=0x04`. `DATA[0]` is the number of
entries, then each entry is a 6-byte ASCII tag. A bike with one language returns
`01 65 6e 2d 55 53 00` — one entry, `en-US`.

The controller's own language register holds the index into this list in its low nibble.

---

## 9. Settings

Controller settings are a register file, read in blocks with `CMD=0x01` and written one register
at a time with `CMD=0x02` (§4). Which node you talk to depends on the controller family — `0xF2`
for ADS, `0xF3` for Bafang. Read the capability report (§8) or simply try both.

### Bafang controllers — `0xF3`

Two useful reads:

```
55 AA 01 11 F3 01 00 35     53 bytes from register 0x00 — everything
55 AA 01 11 F3 01 30 05      5 bytes from register 0x30 — just the drivetrain settings
```

| Register | Size | Setting                  | Notes                                     |
| -------- | ---- | ------------------------ | ----------------------------------------- |
| `0x00`   | 1    | Distance unit            | `0` km, `1` miles                         |
| `0x01`   | 1    | Auto-off time            | minutes                                   |
| `0x02`   | 1    | Light-sensor sensitivity |                                           |
| `0x03`   | 1    | Backlight level          |                                           |
| `0x04`   | 1    | Assist level             |                                           |
| `0x05`   | 1    | Riding mode              |                                           |
| `0x06`   | 1    | Language                 | low nibble indexes the language list (§8) |
| `0x07`   | 1    | Distance setting         |                                           |
| `0x08`   | 1    | Start-password enable    |                                           |
| `0x09`   | 4    | Start password           |                                           |
| `0x30`   | 2    | Wheel diameter           | scaled, inches                            |
| `0x32`   | 2    | Speed limit              | scaled, km/h                              |
| `0x34`   | 1    | Battery display type     |                                           |
| `0x35`   | 1    | Clear odometer           | write `0x01` to trigger                   |
| `0x36`   | 1    | Clear trip               | write `0x01` to trigger                   |

Registers `0x0D`–`0x2F` read as zero and have no known meaning.

A factory reset is an action rather than a register write: `55 AA 01 11 F3 03 11 01`.

Values from an Air 20Pro, showing the full 53-byte read:

```
reg 0x00  00 0a 00 03 05 00 81 05 00 00 00 00 00 00 00 00
reg 0x10  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
reg 0x20  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
reg 0x30  c8 00 fa 00 00
```

Wheel diameter `c8 00` is 20.0 inches, matching the model name, and speed limit `fa 00` is
25.0 km/h, matching the EU assist limit. Language `0x81` selects index 1.

### ADS controllers — `0xF2`

```
55 AA 01 11 F2 01 01 0D     13 bytes from register 0x01
```

| Register | Size | Setting                                  |
| -------- | ---- | ---------------------------------------- |
| `0x01`   | 1    | Language                                 |
| `0x02`   | 1    | Start password — 9-byte write, see below |
| `0x0B`   | 1    | Assist level                             |
| `0x0C`   | 1    | Zero-level enable                        |
| `0x0D`   | 1    | Voltage display                          |
| `0x0E`   | 1    | Voltage selection                        |
| `0x0F`   | 2    | Wheel diameter, scaled, 8–35 in          |
| `0x11`   | 1    | Speed-sensor magnet count, 1–100         |
| `0x12`   | 1    | Speed limit, 1–50                        |
| `0x13`   | 1    | Zero-speed start assist                  |
| `0x14`   | 1    | Drive mode                               |
| `0x15`   | 1    | Assist sensitivity, 1–24                 |
| `0x16`   | 1    | Assist start strength, 0–5               |
| `0x17`   | 1    | Magnet disc type                         |
| `0x18`   | 1    | Current limit, 1–18                      |
| `0x19`   | 2    | Undervoltage cut-off, scaled, 1–50       |
| `0x1B`   | 1    | Cruise control                           |
| `0x1C`   | 1    | Display speed ratio                      |
| `0x1D`   | 1    | Controller protocol                      |
| `0x1E`   | 1    | Clear data — write to trigger            |

The ranges are what the official app enforces; the controller itself may accept more.

Registers above `0x0D` have not been observed on the wire — no ADS bike was available to test — so
read them back after writing rather than trusting the layout.

A factory reset is `55 AA 01 11 F2 03 00 01`.

### Passwords

Writing the password register on either family takes a 9-byte payload whose first byte selects the
operation:

| `DATA[0]` | Remaining 8 bytes               | Effect                     |
| --------- | ------------------------------- | -------------------------- |
| `0x00`    | password, then `00 00 00 00`    | Disable the start password |
| `0x01`    | password, then `00 00 00 00`    | Enable it                  |
| `0x02`    | old password, then new password | Change it                  |

Each password is 4 bytes, one decimal digit per byte.

---

## 10. Navigation

The bike's display can show a turn arrow and a distance. Navigation frames go to node `0xF1` with
`CMD=0x03, SUB=0x00`.

| Step          | Frame                              |
| ------------- | ---------------------------------- |
| Start a route | `55 AA 02 11 F1 03 00 01 01 <CRC>` |
| Update        | see below                          |
| End a route   | `55 AA 02 11 F1 03 00 00 03 <CRC>` |

### Turn updates

Send one of these about once a second while navigating:

```
55 AA  12  11  F1  03  00 | SEQ  02  TURN0   TURN1   TURN2   REMAINING | CRC
                            \_________ DATA, 18 bytes _______________/
```

| Field       | Size | Meaning                                                |
| ----------- | ---- | ------------------------------------------------------ |
| `SEQ`       | 1    | Counter, incremented per update, wrapping at 256       |
| `0x02`      | 1    | Format tag, constant                                   |
| `TURN0`     | 4    | The manoeuvre being approached                         |
| `TURN1`     | 4    | The one after it, or four zero bytes if unknown        |
| `TURN2`     | 4    | A third slot. The official app always leaves this zero |
| `REMAINING` | 4    | Distance to the destination, metres                    |

Each turn slot is a little-endian 32-bit word packing an icon and a distance:

```
bits 31..24   icon code
bits 23..0    distance to that manoeuvre, metres
```

So a left turn 120 m ahead is `78 00 00 02` on the wire.

### Icon codes

| Code   | Arrow                  |
| ------ | ---------------------- |
| `0x01` | Continue straight      |
| `0x02` | Turn left              |
| `0x03` | Turn right             |
| `0x04` | Bear left              |
| `0x05` | Bear right             |
| `0x06` | Sharp left             |
| `0x07` | Sharp right            |
| `0x08` | U-turn left            |
| `0x09` | U-turn right           |
| `0x0A` | Arrived at destination |

Mapping your own routing engine's manoeuvre types onto these ten is up to you. The official app's
mapping is unreliable and not worth copying — see the reverse-engineering notes.

---

## 11. Lights, clock and other commands

### Lights and display units

Single self-contained frames, all to the display module:

| Frame after `55 AA`  | Effect                     |
| -------------------- | -------------------------- |
| `01 11 A5 03 A6 01`  | Headlight on               |
| `01 11 A5 03 A6 00`  | Headlight off              |
| `01 11 A5 03 E0 00`  | Display distances in km    |
| `01 11 A5 03 E0 01`  | Display distances in miles |
| `01 11 A5 03 A7 <n>` | Set backlight level        |

### Clock

`CMD=0x02, SUB=0x46` to node `0x10`, with a 4-byte little-endian Unix timestamp:

```
55 AA 04 11 10 02 46 <timestamp:LE32> <CRC>
```

The display expects **local** wall-clock time expressed as an epoch value, so add your UTC offset
before sending — for UTC+1, send `epoch + 3600`.

### GPS tracker

Push a MAC address to the tracker module as six raw bytes:

```
55 AA 06 11 A7 03 00 <6-byte MAC> <CRC>
```

### NFC cards

| Frame after `55 AA` | Effect                                              |
| ------------------- | --------------------------------------------------- |
| `01 11 A9 01 00 60` | List enrolled cards                                 |
| `01 11 A9 02 01 01` | Enter enrolment mode — present a card to the reader |
| `01 11 A9 02 01 00` | Leave enrolment mode                                |

Poll the list while enrolling to see a new card appear. The reply is `SRC=0xA9, CMD=0x04` with
`LEN=96`:

- `DATA[0]` low nibble — number of cards
- `DATA[16]` onwards — one 16-byte record per slot, of which the first 15 bytes are the UID. A
  record starting with `0x00` is an empty slot

An enrolled MIFARE card shows up as a 5-byte UID zero-padded to 15.

Deleting a card is a write to register `0x02` of the reader carrying the UID. The official app's
implementation of this is broken (see the reverse-engineering notes), so the exact payload is
unconfirmed; the frame it is trying to build is:

```
55 AA 10 11 A9 02 02 <15-byte UID> 00 <CRC>
```

### Display messages

The display holds a fixed table of strings, and you can only select one by index — there is no way
to send free text. Read the list with the language-list query (§8), then write the index to the
controller's language register (`0x06` on Bafang, `0x01` on ADS).

---

## 12. Firmware update

Firmware is uploaded over this same link in 128-byte chunks. There are four independently
updatable targets, selected by `DST`:

| Target                | Address |
| --------------------- | ------- |
| BLE / display module  | `0xA5`  |
| Motor controller      | `0xA3`  |
| Main battery BMS      | `0xA4`  |
| Secondary battery BMS | `0xB4`  |

> **This can brick your bike.** There is no signature or authenticity check anywhere in the
> process: the only integrity value on the wire is a byte sum that the _sender_ supplies, and the
> upload can replace the bootloader as well as the application. A failed transfer may leave the
> module unable to boot.

### Sequence

| Step   | Frame after `55 AA`                     |
| ------ | --------------------------------------- |
| Start  | `04 11 <dst> 07 FF <size:LE32>`         |
| Data   | `80 11 <dst> 08 <seq> <128-byte chunk>` |
| Verify | `04 11 <dst> 09 02 <bytesum:LE32>`      |
| Reboot | `00 11 <dst> 0A FA`                     |

1. **Start** — `size` is the total image length in bytes.
2. **Data** — chunks of exactly 128 bytes in order, so `LEN` is always `0x80`. Zero-pad the final
   chunk. `seq` starts at 0, advances **only when a chunk is acknowledged**, and wraps at 256; a
   retry re-sends the same chunk with the same `seq`.
3. **Verify** — a plain 32-bit sum of every byte of the image, _unpadded_. This is an ordinary
   sum, not a CRC, and not the frame checksum of §2.
4. **Reboot** — the module restarts and the link drops. Allow a few seconds before reconnecting.

Each chunk is acknowledged with `SUB=0x0B` and a status byte in `DATA[0]`:

| `DATA[0]` | Meaning                        |
| --------- | ------------------------------ |
| `0x00`    | Accepted — send the next chunk |
| `0x01`    | Failed — re-send this chunk    |
| `0x04`    | Not upgradeable                |
| `0x08`    | Verification failed            |

Give up after a bounded number of retries per chunk; the official app allows 20. A failure in
response to the start frame means the target will not accept an update at all.

### Image format

An image is a `B04H` container holding several sub-images — typically bootloader, application and
radio stack — which the module's own bootloader unpacks. Upload the **whole container**, header
included; the size and byte sum you send cover all of it.

All fields little-endian:

```
offset  size   field
0x0000     4   magic "B04H"
0x0004     4   section count N
0x0008     4   total image size, matching the size in the start frame
0x000C     4   CRC32 of the package
0x0020    64   package version string, NUL-padded ASCII
0x0060  N*96   section descriptors
  ...          section payloads
```

Section descriptor `i`, at `0x60 + i * 0x60`:

```
+0x00      4   target/type id
+0x04      4   payload offset from the start of the container
+0x08      4   payload length
+0x0C      4   CRC32 of the payload (standard zlib CRC-32)
+0x20     44   section name, NUL-padded ASCII
+0x4C     20   build timestamp "YYYY-MM-DD HH:MM:SS"
```

Payloads start after the descriptor table and are 8-byte aligned; the last section ends exactly at
the declared total size. Verify the CRC32s before uploading anything.

A worked example — the 507,904-byte module image in [`../firmware/`](../firmware/) is exactly
3,968 chunks with a byte sum of `0x03070831`, giving:

```
55 AA 04 11 A5 07 FF 00 C0 07 00 <CRC>     start, size 0x0007C000
55 AA 04 11 A5 09 02 31 08 07 03 <CRC>     verify
```

---

## 13. Command reference

Every command, as the bytes that follow `55 AA`. Append any variable payload, then the checksum.
Names are the identifiers used in [`ado-opcode-table.json`](./ado-opcode-table.json), which also
carries the original vendor descriptions.

### Session, device and display

| Name             | Bytes               | Payload       | Purpose                                           |
| ---------------- | ------------------- | ------------- | ------------------------------------------------- |
| `identification` | `01 11 10 01 00 04` | —             | Begin authentication. Complete frame, CRC `D8 FF` |
| `ide`            | `10 11 10 20 00`    | 16-byte block | Authentication response                           |
| `code`           | `01 11 A5 01 18 18` | —             | Module firmware version                           |
| `newcode`        | `01 11 F1 01 01 01` | —             | Capability report                                 |
| `langlist`       | `01 11 F1 01 04 01` | —             | Language list                                     |
| `contorlCode`    | `01 11 A3 01 00 30` | —             | Motor controller version                          |
| `zpower`         | `01 11 A4 01 00 30` | —             | Main battery version                              |
| `fpowercode`     | `01 11 B4 01 00 30` | —             | Secondary battery version                         |
| `timeSend`       | `04 11 10 02 46`    | LE32          | Set the clock                                     |
| `openlight`      | `01 11 A5 03 A6 01` | —             | Headlight on                                      |
| `closelight`     | `01 11 A5 03 A6 00` | —             | Headlight off                                     |
| `unitkm`         | `01 11 A5 03 E0 00` | —             | Display in km                                     |
| `unitmile`       | `01 11 A5 03 E0 01` | —             | Display in miles                                  |
| `setAsix`        | `01 11 A5 03 A7`    | 1 byte        | Backlight level                                   |

### Navigation and NFC

| Name          | Bytes                  | Payload  | Purpose              |
| ------------- | ---------------------- | -------- | -------------------- |
| `startadress` | `02 11 F1 03 00 01 01` | —        | Route started        |
| `endadress`   | `02 11 F1 03 00 00 03` | —        | Route ended          |
| `newadress`   | `12 11 F1 03 00`       | 18 bytes | Turn update          |
| `NFC`         | `01 11 A9 01 00 60`    | —        | List cards           |
| `entercard`   | `01 11 A9 02 01 01`    | —        | Enter enrolment mode |
| `outCard`     | `01 11 A9 02 01 00`    | —        | Leave enrolment mode |

### ADS controller settings — `0xF2`

| Name          | Bytes            | Payload | Setting                      |
| ------------- | ---------------- | ------- | ---------------------------- |
| `zlms`        | `01 11 F2 01`    | `01 0D` | Read registers `0x01`–`0x0D` |
| `uartsendmsg` | `01 11 F2 02 01` | 1 byte  | Language                     |
| `pwdopen`     | `09 11 F2 02 02` | 9 bytes | Start password               |
| `gear`        | `01 11 F2 02 0B` | 1 byte  | Assist level                 |
| `lingdangwei` | `01 11 F2 02 0C` | 1 byte  | Zero-level enable            |
| `dianya`      | `01 11 F2 02 0D` | 1 byte  | Voltage display              |
| `dyqhuan`     | `01 11 F2 02 0E` | 1 byte  | Voltage selection            |
| `lunjing`     | `02 11 F2 02 0F` | LE16    | Wheel diameter               |
| `cscgang`     | `01 11 F2 02 11` | 1 byte  | Speed-sensor magnets         |
| `xzsd`        | `01 11 F2 02 12` | 1 byte  | Speed limit                  |
| `lingqidong`  | `01 11 F2 02 13` | 1 byte  | Zero-speed start             |
| `qdfshi`      | `01 11 F2 02 14` | 1 byte  | Drive mode                   |
| `zilimd`      | `01 11 F2 02 15` | 1 byte  | Assist sensitivity           |
| `zlqidongqd`  | `01 11 F2 02 16` | 1 byte  | Assist start strength        |
| `zlcgpanleix` | `01 11 F2 02 17` | 1 byte  | Magnet disc type             |
| `kzqxianliu`  | `01 11 F2 02 18` | 1 byte  | Current limit                |
| `kongzqqyz`   | `02 11 F2 02 19` | LE16    | Undervoltage cut-off         |
| `zdxunhang`   | `01 11 F2 02 1B` | 1 byte  | Cruise control               |
| `sjqingling`  | `01 11 F2 02 1E` | 1 byte  | Clear data                   |
| `restore`     | `01 11 F2 03 00` | 1 byte  | Factory reset                |

### Bafang controller settings — `0xF3`

| Name        | Bytes               | Payload | Setting                      |
| ----------- | ------------------- | ------- | ---------------------------- |
| `candsone`  | `01 11 F3 01 00 35` | —       | Read registers `0x00`–`0x34` |
| `caninfo`   | `01 11 F3 01 30 05` | —       | Read registers `0x30`–`0x34` |
| `skeepli`   | `01 11 F3 02 00`    | 1 byte  | Distance unit                |
| `octime`    | `01 11 F3 02 01`    | 1 byte  | Auto-off time                |
| `guanggan`  | `01 11 F3 02 02`    | 1 byte  | Light sensor                 |
| `canlight`  | `01 11 F3 02 03`    | 1 byte  | Backlight level              |
| `canzhuli`  | `01 11 F3 02 04`    | 1 byte  | Assist level                 |
| `canqixing` | `01 11 F3 02 05`    | 1 byte  | Riding mode                  |
| `msgsend`   | `01 11 F3 02 06`    | 1 byte  | Language                     |
| `juli`      | `01 11 F3 02 07`    | 1 byte  | Distance setting             |
| `canpwd`    | `09 11 F3 02 08`    | 9 bytes | Start password               |
| `canlun`    | `02 11 F3 02 30`    | LE16    | Wheel diameter               |
| `xianspeed` | `02 11 F3 02 32`    | LE16    | Speed limit                  |
| `dianliang` | `01 11 F3 02 34`    | 1 byte  | Battery display type         |
| `dodqc`     | `01 11 F3 02 35 01` | —       | Clear odometer               |
| `tripqc`    | `01 11 F3 02 36 01` | —       | Clear trip                   |
| `canhuifu`  | `01 11 F3 03 11 01` | —       | Factory reset                |

### Firmware update

`<dst>` is the target address from §12.

| Name     | Bytes                  | Payload   | Purpose |
| -------- | ---------------------- | --------- | ------- |
| `start`  | `04 11 <dst> 07 FF`    | LE32 size | Begin   |
| `upload` | `80 11 <dst> 08 <seq>` | 128 bytes | Chunk   |
| `check`  | `04 11 <dst> 09 02`    | LE32 sum  | Verify  |
| `reset`  | `00 11 <dst> 0A FA`    | —         | Reboot  |

---

## 14. Device information tables

Each subsystem exposes a flat table of its identity and live state, read with `CMD=0x01` (§4).
This is where instantaneous power, voltages, currents and temperatures live — none of which the
ADO app reads.

| Node                    | Table                 | Size      |
| ----------------------- | --------------------- | --------- |
| `0xA3` motor controller | Controller            | 237 bytes |
| `0xA4` battery          | Battery               | 244 bytes |
| `0xA5` display          | Meter                 | 198 bytes |
| `0xA7` sensor           | Torque/cadence sensor | 164 bytes |

All four begin with the same 144-byte identity header, and live values follow at offset 144 or
160:

| Offset | Size | Field                   |
| ------ | ---- | ----------------------- |
| 0      | 24   | Hardware version, ASCII |
| 24     | 24   | Firmware version, ASCII |
| 48     | 24   | Model, ASCII            |
| 72     | 40   | Serial number, ASCII    |
| 112    | 16   | Customer number, ASCII  |
| 136    | 16   | Manufacturer, ASCII     |

Strings are `NUL`-terminated and zero-padded to the field width. Integers are little-endian, as
everywhere else.

> Manufacturer's offset was corrected from 128 to 136 while building a TypeScript port of this
> spec, against three separate real captures of `0xA5`'s offset-120 reply (`ado-protocol-test-9`,
> `-13` and `-14`, byte-identical across all three): the string `ADO-EBIKE\0` sits at bytes
> 136-146, with bytes 120-135 reading zero throughout. Reading a NUL-terminated ASCII field from
> the documented offset 128 would decode as an empty string, not `ADO-EBIKE`. This leaves an
> 8-byte unexplained gap between customer number's documented end (127) and manufacturer's actual
> start (136) — either customer number is wider than the documented 16 bytes (24, closing the gap
> exactly), or there's a genuine 8-byte reserved gap between the two fields. Not resolved; nothing
> populates customer number in any capture so far to test against.

> The ADO app only ever reads the **first 48 bytes** of the controller and battery tables — the two
> version strings. The rest of the table is reachable with the same command in principle; see
> "Reading a table" below for what actually happens when you try.

### Reading a table

`meterRead` is `CMD=0x01`, with `SUB` as the start offset and a single data byte giving the
requested length:

```
55 AA 01 11 A3 01 00 3C <CRC>      read 60 bytes from offset 0
```

The reply is `CMD=0x04` with `SUB` echoing the start offset — but **`LEN` is not reliably the
length you asked for.** At offset 0, a short request rounds up to 72 bytes regardless of what was
asked (a 60-byte request came back as 72). At offset 24 or 48, the same size request comes back
exact. At offset 72, a 24-byte request came back as 32. Neither is it capped at the next multiple
of 24, which earlier samples suggested: a 24-byte request at battery offset 168 came back as 68
bytes, and the same request at meter offset 168 came back as 41 — both stop exactly at the next
field boundary or reserved gap rather than at any fixed size. The closest description so far is
"however much data exists from here to the next boundary the firmware recognises," not a length
rule at all — ask for at least as many bytes as you need, and size your buffer to whatever
actually comes back rather than what you requested.

**Not every offset answers, but it isn't "offset 0 only" either.** Every offset tried that lines
up with the start of a real field in the tables below — `0`, `24`, `48`, `72`, `160`, `168`, `196`
— got a reply. A read touching offset `192`, `198`, or anything from `200` to `207`, gets no reply
either, but for a different reason: it crashes the controller instead (see the warning below). The
two that went unanswered without incident, `60` and `144`, both fall either mid-field or on a gap
this document already calls "reserved," not a genuine field. Field alignment predicts which
offsets get _a reply_ — but it does not predict which requests are _safe_, and a lack of reply on
its own doesn't tell you which kind of "no" you got.

> **On the motor controller, do not read offset 192, offset 198, or anything from 200 to 207
> inclusive.** This is not a single contiguous window — offset 196, sitting between two of these,
> is confirmed safe — so check each of these individually rather than assuming a range. It has
> been established the hard way, in stages, getting _narrower_ as well as wider: a request
> starting exactly at offset 200 crashed the controller; a 24-byte request starting at offset 192
> also crashed it, at the time attributed to its range reaching into 200-201; a request starting
> at offset 202 — chosen to start clear of the hazard as then understood — crashed it too, and
> manual testing afterwards found offsets up to 206 do the same; a 2-byte request at offset 192
> alone — too short to touch 200-201 — crashed it again, showing "byte range overlapping 200-201"
> was never the actual mechanism; finally, offset 196 answered cleanly while offset 198, right next
> to it, crashed the controller, ruling out "one hazardous block from 192 to 207" as well. Offset
> 194 has no data point either way — not read, not excluded, genuinely unknown. 208 onward has
> been requested and answered with silence, not a crash, so it's confirmed safe to request (though
> not always answered). A request ending at offset 191 (started at 168) is confirmed fine. Given
> this boundary has already been revised several times, do not treat any of the above as final.
> Two further, unrelated incidents show the same failure mode can also be triggered by length
> alone: the full 237-byte controller table at offset 0, and a 128-byte request at offset 160. Up
> to 72 bytes has been requested repeatedly, at several offsets clear of the excluded ones, without
> incident, but that is not a general safety margin for lengths beyond 72 — only a set of specific
> points that happen not to have failed yet.
>
> **On the display/meter, do not read offset 164 or 165** — "current assist level" on that table,
> the same field name as the controller's own dangerous offset 192, and possibly not a coincidence
> (see the caveats under `0xA5` below). Unlike the controller, this looks like a single isolated
> field rather than part of a wider block: offsets 163 and 166, immediately either side of it, are
> both confirmed safe. `0xA4` and `0xA7` have not crashed at all so far, including single reads of
> up to 68 bytes on `0xA4`, but that is not proof no equivalent hazard exists on either, only that
> none has been found yet. See
> [`reverse-engineering.md`](./reverse-engineering.md) §10 for the sessions this is based on
> before requesting anything not already listed there as tried.

### Motor controller — `0xA3`

| Offset | Size | Field                                      | Unit                                   |
| ------ | ---- | ------------------------------------------ | -------------------------------------- |
| 160    | 2    | Battery level                              | %                                      |
| 162    | 2    | Trip distance                              | 0.01 km                                |
| 164    | 2    | Odometer                                   | 0.01 km                                |
| 166    | 2    | Remaining range                            | 0.01 km                                |
| 168    | 2    | Cadence                                    | rpm                                    |
| 170    | 2    | **Torque sensor signal**                   | mV                                     |
| 172    | 2    | Speed                                      | 0.01 km/h                              |
| 174    | 2    | **Motor current**                          | 0.01 A                                 |
| 176    | 2    | **Battery voltage**                        | 0.01 V                                 |
| 178    | 2    | **Controller temperature**                 | °C, subtract 40                        |
| 180    | 2    | **Motor temperature**                      | °C, subtract 40; `255` means no sensor |
| 182    | 2    | Boost (walk assist) active                 | 0/1                                    |
| 184    | 2    | Speed limit                                | 0.01 km/h                              |
| 186    | 2    | Wheel diameter                             | 0.1 in                                 |
| 188    | 2    | Tyre circumference                         | mm                                     |
| 190    | 2    | Calories                                   | kcal                                   |
| 192    | 2    | Current assist level                       |                                        |
| 194    | 2    | Number of assist levels                    |                                        |
| 196    | 2    | Wheel speed                                | rpm                                    |
| 198    | 2    | Wheel revolution counter                   |                                        |
| 200    | 2    | Time since last speed-sensor pulse         | ms                                     |
| 202    | 2    | Crank cadence pulse counter                |                                        |
| 204    | 2    | Motor gearbox — total gears                |                                        |
| 206    | 2    | Motor gearbox — current gear               |                                        |
| 208    | 1    | Cruise control                             | 0/1                                    |
| 209    | 1    | Default assist level on power-up — enabled | 0/1                                    |
| 210    | 1    | Default assist level on power-up — value   |                                        |
| 211    | 2    | Motor starting angle                       | °                                      |
| 213    | 1    | Acceleration setting                       | s                                      |
| 214    | 10   | Per-level speed limits, one byte each      |                                        |
| 224    | 10   | Per-level current limits, one byte each    |                                        |
| 234    | 1    | Buzzer                                     | 0/1                                    |
| 236    | 1    | Controller protocol version                |                                        |

**Instantaneous motor power** is not a field — compute it:

```
watts = (raw_voltage * raw_current) / 10000        # both are 0.01 units
```

Note that the controller's own `Battery level`, `Speed`, `Trip distance` and `Odometer` duplicate
the status report (§7) but at finer resolution: speed here is 0.01 km/h against the report's
0.1 km/h.

### Battery — `0xA4`

Live values start at 144 on this table, not 160.

| Offset | Size | Field                                             | Unit            |
| ------ | ---- | ------------------------------------------------- | --------------- |
| 144    | 2    | Full capacity                                     | mAh             |
| 146    | 2    | Remaining capacity                                | mAh             |
| 148    | 2    | Charge, relative to current full capacity         | %               |
| 150    | 2    | Charge, relative to design capacity               | %               |
| 152    | 2    | **Pack current, signed** — negative when charging | 0.01 A          |
| 154    | 2    | **Pack voltage**                                  | 0.1 V           |
| 156    | 2    | Pack temperature                                  | °C, subtract 40 |
| 158    | 1    | Heater active                                     | 0/1             |
| 159    | 1    | Charging                                          | 0/1             |
| 160    | 1    | Discharging                                       | 0/1             |
| 162    | 1    | Cells in series                                   |                 |
| 163    | 1    | Cells in parallel                                 |                 |
| 164    | 2    | Design capacity                                   | mAh             |
| 166    | 2    | Charge cycles                                     |                 |
| 168    | 2    | Longest time left uncharged                       | h               |
| 170    | 2    | Time since last charge                            | h               |
| 172    | 64   | **Per-cell voltages** — up to 32 × 2 bytes        | mV              |
| 236    | 4    | Maximum permitted charge voltage                  | 0.01 V          |
| 240    | 4    | Maximum permitted charge current                  | 0.01 A          |

The cell block is a plain array of little-endian 16-bit millivolt readings; unpopulated cells read
zero, so take the series count at offset 162 as the number of valid entries.

### Torque sensor — `0xA7`

| Offset | Size | Field         | Unit |
| ------ | ---- | ------------- | ---- |
| 160    | 2    | Torque signal | mV   |
| 162    | 2    | Cadence       | rpm  |

Note this contradicts the ADO app, which sends a MAC address to `0xA7` (§11) as if it were a
tracker. One of the two is wrong; reading the table is the cheap way to find out which.

### Display — `0xA5`

> Offset 164 ("current assist level," below) crashes the bike if read — see the warning under
> §14's controller table above. 163 and 166, either side of it, are confirmed safe.

| Offset | Size | Field                   | Unit     |
| ------ | ---- | ----------------------- | -------- |
| 160    | 2    | Number of assist levels |          |
| 162    | 1    | Sport mode              |          |
| 163    | 1    | Boost active            | 0/1      |
| 164    | 2    | Current assist level    |          |
| 166    | 2    | Backlight               |          |
| 168    | 2    | Odometer                | km       |
| 170    | 2    | Trip distance           | km       |
| 172    | 2    | Maximum speed           | 0.1 km/h |
| 174    | 2    | Average speed           | 0.1 km/h |
| 176    | 4    | Distance since service  | km       |
| 180    | 2    | Auto-off time           | min      |
| 182    | 2    | Maximum auto-off time   | min      |
| 184    | 2    | Unit switch             |          |
| 186    | 4    | Total ride time         | min      |
| 190    | 4    | Total calories          | kcal     |
| 194    | 4    | Trip distance, wide     |          |

### Caveats

The identity header's first three fields are confirmed on an ADO bike, on every node that answers
at all: `0xA3` and `0xA4` from the ADO app's own 48-byte `contorlCode`/`zpower` reads, and all of
`0xA3`, `0xA4` and `0xA5` from this spec's own reads at offset 0 — hardware version, firmware
version and model, back-to-back. `0xA5`'s model field is the first confirmation that field is
populated at all: `B02H`, matching the module firmware string (`newcode`/`code`, §8).

The controller's live block (offset 160 onward) has now been partially read, at offset 160 with a
24-byte request. Battery level came back `100%`, matching the independently-read status report
exactly — a good independent check that this offset is genuinely the field this document says it
is. Battery voltage came back `41.30 V`, a plausible pack voltage and the first real voltage
reading this investigation has produced. Speed, cadence and motor current all read zero, which is
correct for a bike standing still. The two temperature fields both came back the identical raw
value, `20` — which the "subtract 40" scaling in the table below turns into an implausible -20°C;
unadjusted, `20` reads as an ordinary room temperature. Two sensors landing on the exact same
reading by coincidence is possible but not the way to bet; treat both temperature fields, and
anything at or past this offset that hasn't independently cross-checked against another source,
as unconfirmed until read again. A 24-byte read at offset 168, three fields further into the live
block, has also been read cleanly. Offset 192 (a bare 2-byte request, not merely one whose range
reached elsewhere), offset 198, and 200-207 are the confirmed hazard on this table; offset 196,
sitting between 192 and 198, is confirmed safe — so this is not one contiguous window, whatever it
is. Offset 194 has no data point either way. Offset 196's own reply, incidentally, was `0` despite
the wheel turning during the test — unconfirmed whether that's the wrong field, a units/timing
issue, or a value this firmware doesn't populate over BLE. A read stopping at offset 191 (168, 24
bytes) is confirmed fine. This picture has already changed several times and should not be treated
as final — see the warning above and
[`reverse-engineering.md`](./reverse-engineering.md) §10 for the full account, including which
offsets have and haven't been tried.

A `LEN` larger than requested is normal — round up your buffer, don't treat it as an error. No
reply at all, within a couple of seconds, _usually_ means that offset isn't implemented on this
node — but it is also what a request that's about to crash the bike looks like, for the first
second or two, before the difference becomes visible in whether the background status broadcasts
keep arriving. Don't treat a timeout as automatically benign; see §10 for how to tell the two
apart. A `LEN` smaller than requested has never actually been observed; if it happens, treat it
the same as no reply.

The controller's offset-168 read (168–191) has since added four more fields to the confirmed set:
speed limit read `25.00 km/h`, matching the region-appropriate limit already seen in the settings
block; wheel diameter and tyre circumference read `200` raw and `1595 mm`. The `0.1 in` scaling
now shown for wheel diameter — rather than raw inches — comes from those two numbers agreeing with
each other (20.0 in × π ≈ the circumference read alongside it) and with the settings block's own,
already-scaled wheel-diameter register (§9: `c8 00` = 20.0 in on this same bike). Same reasoning
for battery pack voltage's `0.1 V` scaling: the raw reading, `413`, is only a plausible pack
voltage (`41.3 V`) under that scaling, and it then matches the controller's own battery-voltage
field almost exactly. Pack voltage has since been read again, on a separate day: raw `412` against
a controller reading of `41.20 V` — the underlying value moved slightly between sessions, as a
resting battery's does, and the scaled result still matched its independent cross-check both
times, which is considerably stronger evidence than a static value repeating. Pack voltage's
scaling has a third confirmation, independent of any register cross-check: this pack is known to
be 37V nominal / ~42V full-charge, a standard 10S lithium-ion e-bike pack, and every reading this
dashboard has produced — low-to-mid 41V — sits exactly where that chemistry puts a
mostly-to-fully-charged pack. Treat pack voltage's scaling as settled. Wheel diameter's `0.1 in`
scaling is settled too: this bike's wheel is independently known to be 20in, and the old sweep
webapp's settings-block parser — which applies the same scale via a different code path — has
also shown 20.0in. The meter's serial number
field, previously blank on every node tried, came back non-empty for the first time:
`938513864N00651`.

Every crash on record until now happened reading `0xA3`. That changed when `0xA5` offset 164 —
also called "current assist level" on that table, the same name as the controller's own dangerous
offset 192 — produced the identical symptom: status broadcasts stop, then the connection drops a
couple of seconds later. Worth being precise about what this rules out: it is not "the controller's
firmware has a bug," since the request that triggered it never went near `0xA3`. Everything
observed so far — on any node — is consistent with a fault on the shared internal bus the app
never sees, that locks up regardless of which node's read exposed it; "crashes the controller" in
this document, where it predates this run, was always shorthand for "the whole bike goes
unresponsive," not a claim about which physical part actually failed.

Sanity-check before trusting a decode: wheel diameter at offset 186 should match the bike, the
speed limit at 184 should match the legal limit for your region, and voltage at 176 should be near
the pack voltage at battery offset 154.

---
