/** Nordic UART GATT service used by the bike's BLE module. */
export const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
/** App -> bike. */
export const WRITE_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
/** Bike -> app. */
export const NOTIFY_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

export const MAGIC = new Uint8Array([0x55, 0xaa]);

export const ADDR_APP = 0x11;
export const ADDR_MODULE = 0x10;
export const ADDR_CONTROLLER = 0xa3;
export const ADDR_BATTERY = 0xa4;
export const ADDR_METER = 0xa5;
export const ADDR_SENSOR = 0xa7;

export const CMD_READ = 0x01;
export const CMD_READ_REPLY = 0x04;
export const CMD_AUTH = 0x20;
export const CMD_STATUS = 0x06;

/** Status broadcast groups, pushed unprompted every ~250ms once authenticated. */
export const STATUS_SUB_LIVE = 0x01;
export const STATUS_SUB_TRIP = 0x09;

/** ASCII "2CTDU40qNyCgTjb1" — fixed AES-128 key used by every bike of this model. */
export const AUTH_KEY_HEX = "32435444553430714e794367546a6231";

/** Sent verbatim to kick off the auth handshake. */
export const IDENTIFICATION_FRAME_HEX = "55aa011110010004d8ff";

/** Per-request reply timeout: an unimplemented register is silently ignored, not an error. */
export const READ_TIMEOUT_MS = 2000;

/** How often {@link AdoBike.refreshDetail} is called automatically once connected. */
export const DETAIL_REFRESH_MS = 3000;
