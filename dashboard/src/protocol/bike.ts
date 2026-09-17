/**
 * The public entry point to this module. `AdoBike` is the only class that talks to both
 * `transport.ts` and `safety.ts` — every read it ever issues goes through `#safeRead`, which
 * calls `assertReadIsSafe` first. No method here takes an arbitrary offset/length; the fixed
 * list of reads in `#fetchIdentity`/`refreshDetail` is the only thing this class ever requests.
 *
 * Which ranges are dangerous is per-bike-model data (see `profiles.ts`), not something this
 * class or `safety.ts` hardcodes. Identity is read first, using no model-specific data at all
 * (offsets 0-143 have never shown a hazard on any node this project has tested); the meter's
 * `model` string then selects a profile. No matching profile means no further reads at all —
 * see `connectionState === "unsupported-model"`.
 */
import { computeAuthResponse } from "./auth.js";
import { buildFrame } from "./codec.js";
import { unhex } from "./bytes.js";
import {
  ADDR_BATTERY,
  ADDR_CONTROLLER,
  ADDR_METER,
  ADDR_MODULE,
  ADDR_SENSOR,
  CMD_AUTH,
  CMD_READ_REPLY,
  DETAIL_REFRESH_MS,
  IDENTIFICATION_FRAME_HEX,
  SERVICE_UUID,
  STATUS_SUB_LIVE,
  STATUS_SUB_TRIP,
} from "./constants.js";
import { decodeLiveStatus, decodeTripStats } from "./decode.js";
import {
  decodeBatteryDetail,
  decodeControllerDetail,
  decodeIdentity,
  decodeMeterDetail,
  type TaggedReply,
} from "./fields.js";
import { findProfile, type BikeProfile } from "./profiles.js";
import {
  extractDeviceTableRawSamples,
  extractLiveBroadcastRawSamples,
  extractTripBroadcastRawSamples,
  type RawSample,
} from "./raw-samples.js";
import { assertReadIsSafe, LockupWatchdog, type ByteRange } from "./safety.js";
import { connectTransport, type AdoTransport } from "./transport.js";
import type {
  BikeDetail,
  ConnectionState,
  Frame,
  LiveStatus,
  ModuleIdentities,
  TripStats,
} from "./types.js";

/** Identity reads (offsets 0-143) need no model-specific hazard data — see the file header. */
const NO_KNOWN_HAZARDS: ReadonlyMap<number, readonly ByteRange[]> = new Map();

export class AdoBike extends EventTarget {
  /** Must be called from a click handler — `requestDevice()` requires a user gesture. */
  static async requestDevice(): Promise<BluetoothDevice> {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth is not available in this browser");
    }
    return navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "ADO" }, { namePrefix: "ado" }, { namePrefix: "Ado" }],
      optionalServices: [SERVICE_UUID],
    });
  }

  /**
   * Devices the user has already granted permission for in a previous session, via
   * {@link requestDevice}. Unlike `requestDevice()`, this needs no user gesture and shows no
   * picker — it's what lets a reconnect be silent. Chrome/Edge only; resolves to `[]` (not a
   * rejection) on any browser that lacks `getDevices()`, so callers can use it unconditionally.
   */
  static async getKnownDevices(): Promise<BluetoothDevice[]> {
    if (!navigator.bluetooth?.getDevices) return [];
    return navigator.bluetooth.getDevices();
  }

  readonly #device: BluetoothDevice;
  readonly #watchdog = new LockupWatchdog();

  #transport: AdoTransport | undefined;
  #unsubscribeFrame: (() => void) | undefined;
  #detailTimer: ReturnType<typeof setInterval> | undefined;
  #authenticated = false;
  #authResolve: (() => void) | undefined;
  #authReject: ((error: Error) => void) | undefined;

  #state: ConnectionState = "disconnected";
  #profile: BikeProfile | undefined;
  #identities: ModuleIdentities | undefined;
  #liveStatus: LiveStatus | undefined;
  #tripStats: TripStats | undefined;

  constructor(device: BluetoothDevice) {
    super();
    this.#device = device;
  }

  get connectionState(): ConnectionState {
    return this.#state;
  }

  /** The matched bike-model profile, once identity has been read — see `profiles.ts`. */
  get profile(): BikeProfile | undefined {
    return this.#profile;
  }

  get identities(): ModuleIdentities | undefined {
    return this.#identities;
  }

  get liveStatus(): LiveStatus | undefined {
    return this.#liveStatus;
  }

  get tripStats(): TripStats | undefined {
    return this.#tripStats;
  }

  async connect(): Promise<void> {
    this.#setState("connecting");
    this.#device.addEventListener("gattserverdisconnected", this.#handleGattDisconnected);

    try {
      const transport = await connectTransport(this.#device);
      this.#transport = transport;
      this.#unsubscribeFrame = transport.onFrame(this.#handleFrame);

      this.#setState("authenticating");
      const authenticated = new Promise<void>((resolve, reject) => {
        this.#authResolve = resolve;
        this.#authReject = reject;
      });
      await transport.send(unhex(IDENTIFICATION_FRAME_HEX));
      await authenticated;

      this.#setState("ready");
      await this.#fetchIdentity();

      const modelId = this.#identities?.meter.model ?? "";
      this.#profile = findProfile(modelId);
      if (!this.#profile) {
        this.#setState("unsupported-model");
        await this.refreshDetail(); // populates the zero-filled fallback shape, sends no reads
        return;
      }

      await this.refreshDetail();
      this.#detailTimer = setInterval(() => void this.refreshDetail(), DETAIL_REFRESH_MS);
    } catch (error) {
      this.#setState("disconnected");
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.#device.gatt?.disconnect();
    this.#teardown();
  }

  /**
   * Issues exactly the fixed reads this dashboard ever sends for the currently-matched profile,
   * decodes them, and returns the merged result. Stops early — without throwing — if a lockup
   * becomes suspected partway through, rather than continuing to fire requests into a dead
   * connection. Does nothing if no profile is matched (see `connectionState`).
   */
  async refreshDetail(): Promise<BikeDetail> {
    if (!this.#profile) {
      // No matched profile means no confirmed-safe register list for this model — don't guess
      // by falling through to a request with an empty dangerous-ranges map, which would block
      // nothing. Same "no data" shape callers get from every individual read failing.
      const detail: BikeDetail = {
        controller: decodeControllerDetail(undefined, undefined, undefined),
        battery: decodeBatteryDetail(undefined, undefined),
        meter: decodeMeterDetail(undefined, undefined, undefined, undefined),
      };
      this.dispatchEvent(new CustomEvent<BikeDetail>("detail", { detail }));
      return detail;
    }
    const ranges = this.#profile.dangerousRanges;

    // Only this first read is unguarded — it's the one that might newly discover a lockup this
    // cycle, so gating it on #lockupSuspected would be checking a flag it hasn't had a chance to
    // set yet. Every read after it uses #readUnlessLockedUp so a lockup discovered here doesn't
    // waste further requests on a connection #recoverFromLockup is about to tear down anyway.
    const controllerLive = await this.#safeRead(ADDR_CONTROLLER, 160, 24, ranges);
    const controllerConfig = await this.#readUnlessLockedUp(ADDR_CONTROLLER, 168, 24, ranges);
    const wheelSpeed = await this.#readUnlessLockedUp(ADDR_CONTROLLER, 196, 2, ranges);
    const controller = decodeControllerDetail(controllerLive, controllerConfig, wheelSpeed);

    const batteryDetail = await this.#readUnlessLockedUp(ADDR_BATTERY, 144, 24, ranges);
    const batteryMaxCharge = await this.#readUnlessLockedUp(ADDR_BATTERY, 236, 4, ranges);
    const battery = decodeBatteryDetail(batteryDetail, batteryMaxCharge);

    const assistLevels = await this.#readUnlessLockedUp(ADDR_METER, 160, 2, ranges);
    const sportMode = await this.#readUnlessLockedUp(ADDR_METER, 162, 1, ranges);
    const backlight = await this.#readUnlessLockedUp(ADDR_METER, 166, 2, ranges);
    const meterTrip = await this.#readUnlessLockedUp(ADDR_METER, 168, 24, ranges);
    const meter = decodeMeterDetail(assistLevels, sportMode, backlight, meterTrip);

    const detail: BikeDetail = { controller, battery, meter };
    this.dispatchEvent(new CustomEvent<BikeDetail>("detail", { detail }));
    return detail;
  }

  get #lockupSuspected(): boolean {
    return this.#state === "lockup-suspected";
  }

  /**
   * Reads identity (hardware/firmware version, model, serial, manufacturer) for all four bus
   * nodes, using {@link NO_KNOWN_HAZARDS} since offsets 0-143 need no per-model data. `sensor`
   * (0xA7) only ever gets the offset-0 read — every other offset on it has gone unanswered
   * across many hardware sessions, so there's nothing to gain from also requesting its serial.
   */
  async #fetchIdentity(): Promise<void> {
    // First read left unguarded, same reasoning as refreshDetail's controllerLive.
    const controllerHeader = await this.#safeRead(ADDR_CONTROLLER, 0, 60, NO_KNOWN_HAZARDS);
    const controllerSerial = await this.#readUnlessLockedUp(ADDR_CONTROLLER, 72, 24, NO_KNOWN_HAZARDS);
    const controller = decodeIdentity(
      controllerHeader ?? { offset: 0, data: new Uint8Array(0) },
      controllerSerial,
      undefined,
    );

    const batteryHeader = await this.#readUnlessLockedUp(ADDR_BATTERY, 0, 60, NO_KNOWN_HAZARDS);
    const batterySerial = await this.#readUnlessLockedUp(ADDR_BATTERY, 72, 24, NO_KNOWN_HAZARDS);
    const battery = decodeIdentity(
      batteryHeader ?? { offset: 0, data: new Uint8Array(0) },
      batterySerial,
      undefined,
    );

    const meterHeader = await this.#readUnlessLockedUp(ADDR_METER, 0, 60, NO_KNOWN_HAZARDS);
    const meterSerial = await this.#readUnlessLockedUp(ADDR_METER, 72, 32, NO_KNOWN_HAZARDS);
    const meterManufacturer = await this.#readUnlessLockedUp(ADDR_METER, 120, 32, NO_KNOWN_HAZARDS);
    const meter = decodeIdentity(
      meterHeader ?? { offset: 0, data: new Uint8Array(0) },
      meterSerial,
      meterManufacturer,
    );

    const sensorHeader = await this.#readUnlessLockedUp(ADDR_SENSOR, 0, 60, NO_KNOWN_HAZARDS);
    const sensor = decodeIdentity(
      sensorHeader ?? { offset: 0, data: new Uint8Array(0) },
      undefined,
      undefined,
    );

    this.#identities = { controller, battery, meter, sensor };
  }

  async #safeRead(
    node: number,
    offset: number,
    length: number,
    dangerousRanges: ReadonlyMap<number, readonly ByteRange[]>,
  ): Promise<TaggedReply | undefined> {
    assertReadIsSafe(node, offset, length, dangerousRanges);
    if (!this.#transport) return undefined;

    const data = await this.#transport.readRegister(node, offset, length);
    if (data) return { offset, data };

    if (this.#watchdog.isLockupSuspected()) {
      const wasAlreadySuspected = this.#state === "lockup-suspected";
      this.#setState("lockup-suspected");
      this.dispatchEvent(new Event("lockup-suspected"));
      // Only trigger recovery on the transition into this state, not on every subsequent failed
      // read — disconnect() below cancels the detail-refresh timer that drives those reads, so
      // there won't be a "subsequent" one anyway once recovery has actually started.
      if (!wasAlreadySuspected) void this.#recoverFromLockup();
    }
    return undefined;
  }

  /**
   * Every read in `refreshDetail()`/`#fetchIdentity()` but the first goes through this instead
   * of `#safeRead` directly: once one read in a batch trips the lockup watchdog, there's no
   * point sending the rest into a bus that's already been declared dead.
   */
  async #readUnlessLockedUp(
    node: number,
    offset: number,
    length: number,
    dangerousRanges: ReadonlyMap<number, readonly ByteRange[]>,
  ): Promise<TaggedReply | undefined> {
    return this.#lockupSuspected ? undefined : this.#safeRead(node, offset, length, dangerousRanges);
  }

  /**
   * A confirmed lockup means the bike's internal bus has stopped responding to anything — see
   * reverse-engineering.md §10 for the history. That's historically needed a power-cycle to
   * clear, but the BLE link itself sometimes stays reported as "connected" for a long time after
   * the bus goes quiet, with no `gattserverdisconnected` event of its own to signal it. Tearing
   * the connection down ourselves, rather than waiting on that event, is what lets
   * `BikeController`'s reconnect poll pick the bike back up as soon as it's actually usable
   * again, instead of sitting in "lockup-suspected" indefinitely.
   */
  async #recoverFromLockup(): Promise<void> {
    await this.disconnect();
  }

  #handleFrame = (frame: Frame, receivedAt: number): void => {
    this.#watchdog.noteFrameReceived(receivedAt);

    if (!this.#authenticated && frame.sub === 0x00 && frame.cmd !== CMD_AUTH) {
      void this.#respondToChallenge(frame.data);
      return;
    }
    if (frame.cmd === CMD_AUTH && frame.sub === 0x00) {
      this.#authenticated = true;
      this.#authResolve?.();
      return;
    }
    if (frame.sub === STATUS_SUB_LIVE && frame.data.length >= 21) {
      this.#liveStatus = decodeLiveStatus(frame.data);
      this.#dispatchRawSamples(extractLiveBroadcastRawSamples(frame.data, receivedAt));
      this.dispatchEvent(new Event("telemetry"));
      return;
    }
    if (frame.sub === STATUS_SUB_TRIP && frame.data.length >= 20) {
      this.#tripStats = decodeTripStats(frame.data);
      this.#dispatchRawSamples(extractTripBroadcastRawSamples(frame.data, receivedAt));
      this.dispatchEvent(new Event("telemetry"));
      return;
    }
    if (frame.cmd === CMD_READ_REPLY) {
      // Covers every register-read reply this class ever receives, including identity (offsets
      // 0-143) — those simply produce no raw samples, since no field table covers them.
      this.#dispatchRawSamples(
        extractDeviceTableRawSamples(frame.src, frame.sub, frame.data, receivedAt),
      );
    }
  };

  /** Fires "rawsamples" once per frame that carried at least one recognised field. */
  #dispatchRawSamples(samples: RawSample[]): void {
    if (samples.length === 0) return;
    this.dispatchEvent(new CustomEvent<RawSample[]>("rawsamples", { detail: samples }));
  }

  async #respondToChallenge(challenge: Uint8Array): Promise<void> {
    try {
      const block = await computeAuthResponse(challenge);
      await this.#transport?.send(buildFrame(ADDR_MODULE, CMD_AUTH, 0x00, block));
    } catch (error) {
      this.#authReject?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #handleGattDisconnected = (): void => {
    this.#teardown();
  };

  /**
   * Shared by an explicit `disconnect()` and an unprompted `gattserverdisconnected` event.
   * Clearing `#transport` matters even mid-request: it's what makes the rest of a `refreshDetail()`
   * this interrupted (e.g. via lockup recovery) short-circuit through `#safeRead`'s own
   * `if (!this.#transport)` guard instead of issuing more requests on a connection that's gone.
   */
  #teardown(): void {
    if (this.#detailTimer !== undefined) clearInterval(this.#detailTimer);
    this.#detailTimer = undefined;
    this.#unsubscribeFrame?.();
    this.#device.removeEventListener("gattserverdisconnected", this.#handleGattDisconnected);
    this.#transport = undefined;
    this.#setState("disconnected");
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.dispatchEvent(new CustomEvent<ConnectionState>("connectionstatechange", { detail: state }));
  }
}
