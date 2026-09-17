import type { ReactiveController, ReactiveControllerHost } from "lit";
import {
  AdoBike,
  type BikeDetail,
  type BikeProfile,
  type ConnectionState,
  type LiveStatus,
  type ModuleIdentities,
  type RawSample,
  type TripStats,
} from "../../protocol/index.js";
import { pushHistorySample, type HistorySample } from "../history.js";
import { MetricHistory } from "../metric-history.js";
import { SessionRecorder } from "../session-recorder.js";
import { torquePercent } from "../torque.js";

/** How often to check whether a previously-paired bike has come into range while disconnected. */
const AUTO_RECONNECT_POLL_MS = 1000;

/**
 * Wraps an {@link AdoBike}, subscribing to its events and calling `host.requestUpdate()` on
 * every change — the idiomatic Lit answer to a push-based external data source. `ado-app.ts` is
 * the only place that constructs one of these; every component below it only ever sees the
 * plain fields on this controller, never the `AdoBike` instance itself.
 */
export class BikeController implements ReactiveController {
  private readonly host: ReactiveControllerHost;

  bike: AdoBike | undefined;
  state: ConnectionState = "disconnected";
  identities: ModuleIdentities | undefined;
  profile: BikeProfile | undefined;
  live: LiveStatus | undefined;
  trip: TripStats | undefined;
  detail: BikeDetail | undefined;
  error: string | undefined;
  history: HistorySample[] = [];
  torquePercent: number | undefined;
  /** Full-resolution history behind the click-a-tile-to-graph modal — see `metric-history.ts`. */
  metrics = new MetricHistory();

  #autoReconnectTimer: ReturnType<typeof setInterval> | undefined;
  #autoConnecting = false;
  /** Highest torque-sensor voltage seen this connection — see `torque.ts` for why. */
  #torqueBaselineMv = 0;
  #recorder = new SessionRecorder();

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
  }

  hostConnected(): void {
    // Fires once immediately rather than waiting out the first poll interval, then on a timer
    // for as long as the host is connected — see #tryAutoReconnect for why this is silent.
    void this.#tryAutoReconnect();
    this.#autoReconnectTimer = setInterval(
      () => void this.#tryAutoReconnect(),
      AUTO_RECONNECT_POLL_MS,
    );
  }

  hostDisconnected(): void {
    if (this.#autoReconnectTimer !== undefined) clearInterval(this.#autoReconnectTimer);
    this.#autoReconnectTimer = undefined;
    this.#unbind(this.bike);
    this.#recorder.dispose();
  }

  async connect(): Promise<void> {
    this.error = undefined;
    try {
      // AdoBike.requestDevice() must be the first async boundary here, reached with no prior
      // `await`, so the browser's user-gesture activation from the originating click is still
      // live when it's called. A try/catch around it doesn't introduce one.
      const device = await AdoBike.requestDevice();
      await this.#connectWithDevice(device);
    } catch (error) {
      // Covers both requestDevice() failing (no adapter, user cancelled the picker,
      // permission denied) and bike.connect() failing (GATT/auth) — either way the user
      // needs to see *something*, not a connect button that silently does nothing.
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.host.requestUpdate();
    }
  }

  async disconnect(): Promise<void> {
    await this.bike?.disconnect();
  }

  /**
   * Silently tries every device the user has already granted permission to in a past session
   * (via `AdoBike.requestDevice()`), in case one has come back into range. Unlike `connect()`,
   * failures here are expected and routine — "the bike isn't nearby right now" is the normal
   * state most of the time this polls — so they're swallowed rather than surfaced as `error`.
   */
  #tryAutoReconnect = async (): Promise<void> => {
    if (this.state !== "disconnected" || this.#autoConnecting) return;

    const devices = await AdoBike.getKnownDevices();
    if (devices.length === 0 || this.state !== "disconnected") return;

    this.#autoConnecting = true;
    try {
      for (const device of devices) {
        if (this.state !== "disconnected") break; // a manual connect() won the race meanwhile
        try {
          await this.#connectWithDevice(device);
          break;
        } catch {
          // Not in range (or some other transient failure) — try the next remembered device,
          // if any; the next poll tick will retry this one.
        }
      }
    } finally {
      this.#autoConnecting = false;
    }
  };

  /**
   * Shared by both `connect()` and auto-reconnect. On failure, only clears `this.bike` if it
   * still points at the instance created here — a slower failing attempt (e.g. an auto-reconnect
   * try for a device that's not actually in range) must never clobber a *different*, successful
   * connection that started after it.
   */
  async #connectWithDevice(device: BluetoothDevice): Promise<void> {
    const bike = new AdoBike(device);
    this.#bind(bike);
    this.bike = bike;
    this.host.requestUpdate();

    try {
      await bike.connect();
      this.identities = bike.identities;
      this.profile = bike.profile;
      this.#recorder.setModelId(this.profile?.modelId ?? this.identities?.meter.model);
    } catch (error) {
      this.#unbind(bike);
      if (this.bike === bike) this.bike = undefined;
      throw error;
    }
  }

  #handleTelemetry = (): void => {
    // decodeLiveStatus()/decodeTripStats() each produce a fresh object every time they run, so
    // an identity change here means *this* broadcast is the one that just arrived — the other
    // field just carries forward its last value unchanged, and shouldn't be re-recorded as if
    // it had just updated too (both broadcasts share one "telemetry" event).
    const newLive = this.bike?.liveStatus;
    const newTrip = this.bike?.tripStats;
    const liveChanged = newLive !== this.live;
    const tripChanged = newTrip !== this.trip;
    this.live = newLive;
    this.trip = newTrip;

    const t = Date.now();
    if (liveChanged && this.live) {
      this.history = pushHistorySample(this.history, {
        t,
        speedKmh: this.live.speedKmh,
        batteryPercent: this.live.batteryMain.percentage,
        assistLevel: this.live.assistLevel,
      });
      this.metrics.record("hero.speed", this.detail?.controller.speedKmh ?? this.live.speedKmh, t);
      this.metrics.record("hero.batteryPercent", this.live.batteryMain.percentage, t);
      this.metrics.record("hero.assistLevel", this.live.assistLevel, t);
    }
    if (tripChanged && this.trip) {
      this.metrics.record("trip.avgSpeedKmh", this.trip.avgSpeedKmh, t);
      this.metrics.record("trip.maxSpeedKmh", this.trip.maxSpeedKmh, t);
    }
    this.host.requestUpdate();
  };

  #handleRawSamples = (event: Event): void => {
    this.#recorder.record((event as CustomEvent<RawSample[]>).detail);
  };

  #handleDetail = (event: Event): void => {
    this.detail = (event as CustomEvent<BikeDetail>).detail;
    const t = Date.now();

    const c = this.detail?.controller;
    if (c) {
      this.metrics.record("controller.batteryVoltageV", c.batteryVoltageV, t);
      this.metrics.record("controller.motorCurrentA", c.motorCurrentA, t);
      this.metrics.record("controller.computedPowerW", c.computedPowerW, t);
      this.metrics.record("controller.cadenceRpm", c.cadenceRpm, t);
      this.metrics.record("controller.controllerTemperatureC", c.controllerTemperatureC, t);
      this.metrics.record("controller.motorTemperatureC", c.motorTemperatureC, t);
      this.metrics.record("controller.tripKm", c.tripKm, t);
      this.metrics.record("controller.odometerKm", c.odometerKm, t);
      if (c.remainingRangeKm !== undefined) {
        this.metrics.record("controller.remainingRangeKm", c.remainingRangeKm, t);
      }
    }

    const b = this.detail?.battery;
    if (b) {
      this.metrics.record("battery.packVoltageV", b.packVoltageV, t);
      this.metrics.record("battery.packCurrentA", b.packCurrentA, t);
      this.metrics.record("battery.packTemperatureC", b.packTemperatureC, t);
      this.metrics.record("battery.chargeOfFullPercent", b.chargeOfFullPercent, t);
      this.metrics.record("battery.chargeOfDesignPercent", b.chargeOfDesignPercent, t);
      this.metrics.record("battery.fullCapacityMah", b.fullCapacityMah, t);
      this.metrics.record("battery.remainingCapacityMah", b.remainingCapacityMah, t);
      this.metrics.record("battery.maxChargeVoltageV", b.maxChargeVoltageV, t);
      this.metrics.record("battery.maxChargeCurrentA", b.maxChargeCurrentA, t);
    }

    const rawMv = c?.torqueSignalMv;
    if (rawMv !== undefined) {
      this.#torqueBaselineMv = Math.max(this.#torqueBaselineMv, rawMv);
      this.torquePercent = torquePercent(rawMv, this.#torqueBaselineMv);
      this.metrics.record("torque.percent", this.torquePercent, t);
    }
    this.host.requestUpdate();
  };

  #handleStateChange = (event: Event): void => {
    this.state = (event as CustomEvent<ConnectionState>).detail;
    if (this.state === "ready") {
      // The one-time entry point into a live connection (see AdoBike.connect) — starts a new
      // recorded session. modelId isn't known yet at this exact moment; setModelId() catches up
      // once identity's been read, a moment later in #connectWithDevice.
      this.#recorder.start();
    }
    if (this.state === "disconnected") {
      // Don't carry a stale ride's numbers/sparklines into the next connection.
      this.live = undefined;
      this.trip = undefined;
      this.detail = undefined;
      this.identities = undefined;
      this.profile = undefined;
      this.history = [];
      this.torquePercent = undefined;
      this.#torqueBaselineMv = 0;
      this.metrics.reset();
      this.#recorder.end();
    }
    this.host.requestUpdate();
  };

  #handleLockupSuspected = (): void => {
    this.host.requestUpdate();
  };

  #bind(bike: AdoBike): void {
    bike.addEventListener("telemetry", this.#handleTelemetry);
    bike.addEventListener("detail", this.#handleDetail);
    bike.addEventListener("connectionstatechange", this.#handleStateChange);
    bike.addEventListener("lockup-suspected", this.#handleLockupSuspected);
    bike.addEventListener("rawsamples", this.#handleRawSamples);
  }

  /**
   * Takes the instance explicitly rather than reading `this.bike` — a failed connect attempt
   * must only ever detach its own listeners, never whichever bike `this.bike` happens to point
   * at by the time it gets here (see `#connectWithDevice`).
   */
  #unbind(bike: AdoBike | undefined): void {
    if (!bike) return;
    bike.removeEventListener("telemetry", this.#handleTelemetry);
    bike.removeEventListener("detail", this.#handleDetail);
    bike.removeEventListener("connectionstatechange", this.#handleStateChange);
    bike.removeEventListener("lockup-suspected", this.#handleLockupSuspected);
    bike.removeEventListener("rawsamples", this.#handleRawSamples);
  }
}
