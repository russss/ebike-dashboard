"""Reference codec for the ADO e-bike Bluetooth Low Energy protocol.

Companion to ado-ble-protocol.md, which specifies everything implemented here and
records how each behaviour was verified. Section references below point into it.

Reverse-engineered from ADOEBIKE 2.0.4.5; no warranty. Requires the `cryptography`
package.

Run directly to execute the self-tests:

    pip install cryptography
    python3 docs/ado_protocol.py
"""

import struct
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAGIC     = b"\x55\xaa"
ADDR_APP  = 0x11
AUTH_KEY  = bytes.fromhex("32435444553430714E794367546A6231")   # b"2CTDU40qNyCgTjb1"

SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
WRITE_UUID   = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"   # app -> bike
NOTIFY_UUID  = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"   # bike -> app

ADDR_MODULE, ADDR_DISPLAY, ADDR_CTRL   = 0x10, 0xA5, 0xA3
ADDR_BATT1, ADDR_BATT2, ADDR_TRACKER   = 0xA4, 0xB4, 0xA7
ADDR_NFC, ADDR_NAV, ADDR_ADS, ADDR_CAN = 0xA9, 0xF1, 0xF2, 0xF3


# §2 command conventions
CMD_READ, CMD_WRITE, CMD_ACTION = 0x01, 0x02, 0x03
CMD_READ_REPLY, CMD_WRITE_ACK, CMD_STATUS = 0x04, 0x05, 0x06
CMD_AUTH = 0x20


def checksum(payload: bytes) -> bytes:
    """16-bit one's complement of the byte sum, little-endian."""
    return struct.pack("<H", (~sum(payload)) & 0xFFFF)


def build(dst: int, cmd: int, sub: int, data: bytes = b"", src: int = ADDR_APP) -> bytes:
    if len(data) > 0xFF:
        raise ValueError("DATA must be <= 255 bytes")
    payload = bytes([len(data), src, dst, cmd, sub]) + data
    return MAGIC + payload + checksum(payload)


def parse(frame: bytes) -> dict:
    if len(frame) < 9 or frame[:2] != MAGIC:
        raise ValueError("bad magic")
    length, src, dst, cmd, sub = frame[2:7]
    return {
        "len": length, "src": src, "dst": dst, "cmd": cmd, "sub": sub,
        "data": frame[7:7 + length],
        "crc_ok": frame[7 + length:9 + length] == checksum(frame[2:7 + length]),
    }


def read(dst: int, register: int, count: int) -> bytes:
    """§2 read: SUB is the first register, DATA[0] the number of bytes wanted.

    The reply is CMD_READ_REPLY with SUB echoed. On the settings nodes (0xF2, 0xF3) LEN
    equals count exactly. On the device-info tables (0xA3, 0xA4, 0xA5, 0xA7, spec §14) it
    doesn't: LEN comes back rounded up, by an amount that varies with offset, and a request
    that doesn't start on a field the firmware recognises gets no reply at all -- see
    reverse-engineering.md §10.

    SAFETY: on dst=0xA3 (motor controller), never send a request touching register 192,
    register 198, or 200-207 -- and this is not one contiguous window: register 196, sitting
    between two of these, is confirmed safe, so check each individually rather than assuming
    a range. Established in stages, getting narrower as well as wider each time a request
    believed safe turned out not to be: register=200 exactly crashed the controller;
    register=192, count=24 (a range reaching into 200-201 without starting there) crashed it
    too, at the time attributed to that overlap; register=202, count=35 -- chosen to start
    clear of the then-current boundary -- crashed it a third time, and manual testing
    afterwards found registers up to 206 crash as well; register=192, count=2 -- far too
    short to reach 200-201 -- crashed it a fourth time, ruling out byte-range overlap as the
    mechanism; register=196, count=2 answered cleanly while register=198, immediately next to
    it, crashed the controller, ruling out one contiguous hazardous block as well. register=194
    has no data point either way -- not tested, not assumed safe. register=168, count=24
    (ending at 191) is fine; register=208 has been requested and answered with silence, not a
    crash, so it's confirmed safe to request (though not always answered). Given this picture
    has changed shape more than once, do not treat any of the above as final -- see
    reverse-engineering.md §10, seventh, eighth, tenth and twelfth runs and the manual
    follow-up after the twelfth. Two further incidents show count alone can also trigger it,
    unrelated to any of this: count=237 at register=0, and count=128 at register=160. Treat
    every register/count combination not already in reverse-engineering.md §10's run history
    as untested, not as safe by resemblance to one that was.

    SAFETY: on dst=0xA5 (display/meter), never send a request touching register 164 --
    "current assist level" on this table, the same field name as 0xA3's own dangerous
    register 192, confirmed dangerous on its own with a 2-byte request (reverse-engineering.md
    §10, thirteenth run). Unlike 0xA3, this looks like an isolated single field rather than
    part of a wider block: registers 163 and 166, immediately either side, are both confirmed
    safe. Whether this is the same underlying mechanism as 0xA3's hazard, or coincidence, is
    unresolved. dst=0xA4 and dst=0xA7 have not crashed at all so far, but the same class of
    hazard has not been ruled out on either.

    Every crash on record so far, regardless of which dst was targeted, has produced the
    identical symptom: the bike's status broadcasts stop and the BLE connection drops a couple
    of seconds later. This is consistent with a fault on the shared internal bus that locks up
    regardless of which node's read exposed it, not with a bug specific to whichever node was
    being read -- "crashes the controller" elsewhere in this file predates that distinction
    and should be read as "the whole bike goes unresponsive," not a claim about which physical
    part fails."""
    return build(dst, CMD_READ, register, bytes([count]))


# --- authentication ---------------------------------------------------------

IDENTIFICATION = bytes.fromhex("55AA011110010004D8FF")   # send verbatim

def auth_response(challenge: bytes) -> bytes:
    """AES-128-ECB, no padding, over exactly 16 bytes (zero-padded / truncated)."""
    block = (challenge + b"\x00" * 16)[:16]
    encryptor = Cipher(algorithms.AES(AUTH_KEY), modes.ECB()).encryptor()
    return build(ADDR_MODULE, 0x20, 0x00, encryptor.update(block) + encryptor.finalize())


# --- value codecs -----------------------------------------------------------

def le_int(data: bytes) -> int:
    return int.from_bytes(data, "little")

def scalar16(value: float) -> bytes:
    """LEN=2 settings: value * 10 as LE16 fixed-point."""
    return struct.pack("<H", round(value * 10))

def scalar8(value: int) -> bytes:
    """LEN=1 settings: plain integer byte."""
    return bytes([int(value) & 0xFF])

def battery(byte: int) -> dict:
    return {"percentage": byte & 0x7F, "online": bool(byte >> 7)}

def battery_selector(byte: int) -> int:
    return (byte >> 2) & 0x03

def password(pin: str) -> bytes:
    """4 digits, one per byte in the low nibble."""
    if len(pin) != 4 or not pin.isdigit():
        raise ValueError("PIN must be 4 digits")
    return bytes(int(d) for d in pin)


# --- settings ---------------------------------------------------------------

def ads_write(register: int, value: bytes) -> bytes:
    """ADS (UART) controller: SUB is the register address."""
    return build(ADDR_ADS, 0x02, register, value)

def can_write(register: int, value: bytes) -> bytes:
    """Bafang (CAN) controller: SUB is the register address."""
    return build(ADDR_CAN, 0x02, register, value)


# --- navigation -------------------------------------------------------------

NAV_STRAIGHT, NAV_LEFT, NAV_RIGHT       = 0x01, 0x02, 0x03
NAV_BEAR_LEFT, NAV_BEAR_RIGHT           = 0x04, 0x05
NAV_SHARP_LEFT, NAV_SHARP_RIGHT         = 0x06, 0x07
NAV_UTURN_LEFT, NAV_UTURN_RIGHT         = 0x08, 0x09
NAV_ARRIVED                             = 0x0A

def turn_record(icon: int, distance_m: int) -> bytes:
    """icon in the high byte, distance in the low 24 bits, little-endian."""
    return struct.pack("<I", ((icon & 0xFF) << 24) | (round(distance_m) & 0xFFFFFF))

def nav_start() -> bytes:
    return build(ADDR_NAV, 0x03, 0x00, b"\x01\x01")

def nav_end() -> bytes:
    return build(ADDR_NAV, 0x03, 0x00, b"\x00\x03")

def nav_update(seq: int, current, nxt=None, remaining_m: int = 0) -> bytes:
    """current / nxt are (icon, distance_m) tuples."""
    data = (bytes([seq & 0xFF]) + b"\x02"
            + turn_record(*current)
            + (turn_record(*nxt) if nxt else b"\x00" * 4)
            + b"\x00" * 4
            + struct.pack("<I", round(remaining_m)))
    return build(ADDR_NAV, 0x03, 0x00, data)


# --- telemetry --------------------------------------------------------------

def decode_live_status(data: bytes) -> dict:
    """Group SUB=0x01. `data` is the DATA field (frame byte 7 onwards)."""
    return {
        "fault_code":        data[0],
        "battery_secondary": battery(data[1]),
        "discharge_state":   battery_selector(data[2]),
        "headlight_on":      bool(data[4]),
        "assist_level":      data[5],
        "assist_levels":     data[6],
        "battery_main":      battery(data[7]),
        "working_mode":      data[8],
        "speed_kmh":         le_int(data[9:11]) / 10,
        "trip_km":           le_int(data[11:15]) / 100,
        "odometer_km":       le_int(data[15:19]) / 100,
        "calories":          le_int(data[19:21]),
    }

def decode_trip_stats(data: bytes) -> dict:
    """Group SUB=0x09."""
    return {
        "duration_s":      le_int(data[0:4]),
        "avg_speed":       le_int(data[4:6]) / 100,
        "max_speed":       le_int(data[6:8]) / 10,
        "backlight_level": data[12],        # plain level; the app's nibble split is a bug
        "unit_miles":      bool(data[13]),
        "total_ride_s":    le_int(data[16:20]),
    }


# --- firmware / OTA ---------------------------------------------------------

OTA_TARGETS = {1: 0xA5, 2: 0xA3, 3: 0xA4, 4: 0xB4}   # module, controller, batt1, batt2

def parse_b04h(blob: bytes) -> dict:
    """Decode a `B04H` firmware container."""
    import zlib
    if blob[:4] != b"B04H":
        raise ValueError("not a B04H container")
    n, total, pkgcrc = struct.unpack_from("<III", blob, 4)
    secs = []
    for i in range(n):
        b = 0x60 + i * 0x60
        tid, off, ln, crc = struct.unpack_from("<IIII", blob, b)
        payload = blob[off:off + ln]
        secs.append({
            "id": tid, "offset": off, "length": ln, "crc32": crc,
            "crc32_ok": (zlib.crc32(payload) & 0xFFFFFFFF) == crc,
            "name": blob[b + 0x20:b + 0x4C].split(b"\0")[0].decode(),
            "built": blob[b + 0x4C:b + 0x60].split(b"\0")[0].decode(),
            "payload": payload,
        })
    return {"version": blob[0x20:0x60].split(b"\0")[0].decode(),
            "total_size": total, "package_crc32": pkgcrc, "sections": secs}


def ota_frames(image: bytes, target: int = 1):
    """Yield the full OTA frame sequence for `image`. `target` is 1-4."""
    dst = OTA_TARGETS[target]
    yield ("start", build(dst, 0x07, 0xFF, struct.pack("<I", len(image))))
    seq = 0
    for off in range(0, len(image), 128):
        chunk = image[off:off + 128]
        chunk += b"\x00" * (128 - len(chunk))          # app pads the hex string with '0'
        yield ("data", build(dst, 0x08, seq, chunk))
        seq = (seq + 1) % 256
    yield ("verify", build(dst, 0x09, 0x02, struct.pack("<I", sum(image) & 0xFFFFFFFF)))
    yield ("reboot", build(dst, 0x0A, 0xFA))

OTA_ACK = {0x00: "success", 0x01: "failure", 0x04: "not upgradeable", 0x08: "verify failed"}


if __name__ == "__main__":
    # checksum, including the vendor's own fully-framed identification packet
    assert checksum(bytes.fromhex("011110010004"))            == bytes.fromhex("d8ff")
    assert checksum(bytes.fromhex("0611A70300112233445566"))  == bytes.fromhex("d9fd")
    assert checksum(bytes.fromhex("0111F1010101"))            == bytes.fromhex("f9fe")
    assert IDENTIFICATION == MAGIC + bytes.fromhex("011110010004") + bytes.fromhex("d8ff")

    # framing reproduces the vendor's opcodes exactly
    assert build(ADDR_DISPLAY, 0x03, 0xA6, b"\x01")[2:7].hex()   == "0111a503a6"   # openlight
    assert build(ADDR_NAV, 0x03, 0x00, b"\x00" * 18)[2:7].hex()  == "1211f10300"   # newadress
    assert build(ADDR_MODULE, 0x02, 0x46, b"\x00" * 4)[2:7].hex() == "0411100246"  # timeSend
    assert ads_write(0x0F, scalar16(27.5))[2:7].hex()             == "0211f2020f"   # lunjing
    assert can_write(0x30, scalar16(27.5))[2:7].hex()             == "0211f30230"   # canlun

    # auth
    assert auth_response(bytes.fromhex("00112233445566778899aabbccddeeff"))[7:23].hex() == \
           "67d228ce5f51bb500fe42c9a436d2ee8"
    # the exact frame an ADO Air 20Pro accepted, for its 4-byte challenge (§5)
    assert auth_response(bytes.fromhex("3c0af6cf")).hex() == \
           "55aa101110200099115f40211f1dfcf1b5a62ee4959c7904f8"
    assert read(0xA3, 0x00, 0x30)[2:8].hex() == "0111a3010030"        # contorlCode
    assert read(0xF2, 0x01, 0x0D)[2:8].hex() == "0111f201010d"        # zlms — 13 bytes from reg 1
    assert auth_response(b"")[2:7].hex() == "1011102000"                            # ide

    # value codecs
    assert turn_record(0x07, 250).hex() == "fa000007"
    assert le_int(bytes.fromhex("fa00")) == 250
    assert scalar16(27.5).hex() == "1301"
    assert password("3824") == bytes([3, 8, 2, 4])
    assert battery(0xD2) == {"percentage": 82, "online": True}
    assert battery_selector(0x0C) == 3

    # round-trip
    f = nav_update(0x2A, (NAV_LEFT, 120), (NAV_STRAIGHT, 800), 5400)
    p = parse(f)
    assert p["crc_ok"] and p["len"] == 18 and p["dst"] == ADDR_NAV

    # firmware container + OTA framing, against the retrieved module package
    import pathlib
    fw = pathlib.Path(__file__).parent.parent / "firmware" / "module_B02H_C_ADS_IOT02_BF_N11.bin"
    if fw.exists():
        pkg = parse_b04h(fw.read_bytes())
        assert pkg["version"] == "B02H_C_ADS_IOT02_BF_N11"
        assert pkg["total_size"] == len(fw.read_bytes()) == 507904
        assert len(pkg["sections"]) == 3 and all(s["crc32_ok"] for s in pkg["sections"])
        assert pkg["sections"][-1]["offset"] + pkg["sections"][-1]["length"] == pkg["total_size"]
        frames = list(ota_frames(fw.read_bytes(), target=1))
        kinds = [k for k, _ in frames]
        assert kinds[0] == "start" and kinds[-2] == "verify" and kinds[-1] == "reboot"
        assert kinds.count("data") == 3968
        assert frames[0][1].hex()  == "55aa0411a507ff00c00700" + checksum(
            bytes.fromhex("0411a507ff00c00700")).hex()
        assert frames[-2][1][2:11].hex() == "0411a5090231080703"
        assert all(parse(f)["len"] == 0x80 for k, f in frames if k == "data")
        print("firmware self-tests pass (container + OTA framing)")
    print("all self-tests pass")
