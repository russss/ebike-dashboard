import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { BikeController } from "./bike-controller.js";
import { AdoBike, type BikeDetail } from "../../protocol/index.js";
import {
  announceState,
  fakeBikeDetail as fakeDetail,
  fakeDevice,
  fakeLiveStatus,
  fakeTripStats,
} from "../test-fixtures.js";

function fakeHost(): ReactiveControllerHost {
  return {
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  };
}

/** The baseline every describe block below needs: no remembered devices, no identity/profile
 *  yet. Returns the `getKnownDevices` spy since that's the one tests sometimes reconfigure. */
function mockAdoBikeBasics(): ReturnType<typeof vi.spyOn> {
  const getKnownDevices = vi.spyOn(AdoBike, "getKnownDevices").mockResolvedValue([]);
  vi.spyOn(AdoBike.prototype, "identities", "get").mockReturnValue(undefined);
  vi.spyOn(AdoBike.prototype, "profile", "get").mockReturnValue(undefined);
  return getKnownDevices;
}

/** The happy path: requestDevice() resolves and connect() immediately announces "ready". */
function mockSuccessfulConnect(): void {
  vi.spyOn(AdoBike, "requestDevice").mockResolvedValue(fakeDevice("bike-1"));
  vi.spyOn(AdoBike.prototype, "connect").mockImplementation(async function (this: AdoBike) {
    announceState(this, "ready");
  });
}

describe("BikeController — auto-reconnect to a remembered device", () => {
  let getKnownDevices: ReturnType<typeof vi.spyOn>;
  let requestDevice: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    getKnownDevices = mockAdoBikeBasics();
    requestDevice = vi.spyOn(AdoBike, "requestDevice").mockRejectedValue(new Error("not used"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("connects automatically, with no user gesture, when a remembered device is already in range", async () => {
    getKnownDevices.mockResolvedValue([fakeDevice("bike-1")]);
    const connect = vi
      .spyOn(AdoBike.prototype, "connect")
      .mockImplementation(async function (this: AdoBike) {
        announceState(this, "ready");
      });

    const controller = new BikeController(fakeHost());
    controller.hostConnected();
    await vi.waitFor(() => expect(controller.state).toBe("ready"));

    expect(connect).toHaveBeenCalledOnce();
    expect(requestDevice).not.toHaveBeenCalled();
    expect(controller.bike).toBeInstanceOf(AdoBike);
    expect(controller.error).toBeUndefined();

    controller.hostDisconnected();
  });

  it("fails silently — no user-visible error — when the remembered device isn't in range", async () => {
    getKnownDevices.mockResolvedValue([fakeDevice("bike-1")]);
    const connect = vi
      .spyOn(AdoBike.prototype, "connect")
      .mockRejectedValue(new Error("device not in range"));

    const controller = new BikeController(fakeHost());
    controller.hostConnected();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.error).toBeUndefined();
    expect(controller.bike).toBeUndefined();
    expect(controller.state).toBe("disconnected");

    controller.hostDisconnected();
  });

  it("retries about once a second while disconnected, and stops once the host disconnects", async () => {
    getKnownDevices.mockResolvedValue([fakeDevice("bike-1")]);
    const connect = vi
      .spyOn(AdoBike.prototype, "connect")
      .mockRejectedValue(new Error("device not in range"));

    const controller = new BikeController(fakeHost());
    controller.hostConnected();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));

    controller.hostDisconnected();
    await vi.advanceTimersByTimeAsync(5000);
    expect(connect).toHaveBeenCalledTimes(2); // no further attempts once disconnected
  });

  it("never lets a slow, ultimately-failed auto-reconnect clobber a manual connect that wins the race", async () => {
    getKnownDevices.mockResolvedValue([fakeDevice("bike-1")]);

    let failAutoAttempt!: (error: Error) => void;
    const autoAttemptGate = new Promise<void>((_resolve, reject) => {
      failAutoAttempt = reject;
    });

    let calls = 0;
    vi.spyOn(AdoBike.prototype, "connect").mockImplementation(async function (this: AdoBike) {
      calls++;
      if (calls === 1) {
        await autoAttemptGate; // the auto-reconnect attempt: hangs until released below
        return;
      }
      announceState(this, "ready"); // the manual attempt: succeeds immediately
    });

    const controller = new BikeController(fakeHost());
    controller.hostConnected(); // starts the slow auto-reconnect attempt (call #1)
    await vi.waitFor(() => expect(calls).toBe(1));

    requestDevice.mockResolvedValue(fakeDevice("bike-1"));
    const manualConnect = controller.connect(); // races in and wins (call #2)
    await vi.waitFor(() => expect(controller.state).toBe("ready"));
    const manualBike = controller.bike;

    failAutoAttempt(new Error("device not in range")); // the stale attempt finally loses
    await manualConnect;
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.bike).toBe(manualBike);
    expect(controller.state).toBe("ready");

    controller.hostDisconnected();
  });
});

describe("BikeController — torque percent", () => {
  beforeEach(() => {
    mockAdoBikeBasics();
    mockSuccessfulConnect();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calibrates against the highest voltage seen so far, not a hardcoded constant", async () => {
    const controller = new BikeController(fakeHost());
    await controller.connect();
    const bike = controller.bike!;

    bike.dispatchEvent(new CustomEvent<BikeDetail>("detail", { detail: fakeDetail(238) }));
    expect(controller.torquePercent).toBe(0); // first sample becomes the baseline

    bike.dispatchEvent(new CustomEvent<BikeDetail>("detail", { detail: fakeDetail(119) }));
    expect(controller.torquePercent).toBeCloseTo(50);

    // A resting voltage a little higher than the first sample raises the baseline instead of
    // being clamped against the old one — the "highest observed" the user asked for, not the
    // first-ever reading.
    bike.dispatchEvent(new CustomEvent<BikeDetail>("detail", { detail: fakeDetail(250) }));
    expect(controller.torquePercent).toBe(0);

    bike.dispatchEvent(new CustomEvent<BikeDetail>("detail", { detail: fakeDetail(125) }));
    expect(controller.torquePercent).toBeCloseTo(50);
  });

  it("resets the calibration on disconnect rather than carrying it into the next ride", async () => {
    const controller = new BikeController(fakeHost());
    await controller.connect();
    const bike = controller.bike!;

    bike.dispatchEvent(new CustomEvent<BikeDetail>("detail", { detail: fakeDetail(238) }));
    expect(controller.torquePercent).toBe(0);

    announceState(bike, "disconnected");
    expect(controller.torquePercent).toBeUndefined();
  });
});

describe("BikeController — metric history", () => {
  beforeEach(() => {
    mockAdoBikeBasics();
    mockSuccessfulConnect();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a point for every displayed metric a detail update carries", async () => {
    const controller = new BikeController(fakeHost());
    await controller.connect();
    const bike = controller.bike!;

    const detail = fakeDetail(0);
    bike.dispatchEvent(
      new CustomEvent<BikeDetail>("detail", {
        detail: {
          ...detail,
          controller: { ...detail.controller, batteryVoltageV: 41.5, cadenceRpm: 60 },
          battery: { ...detail.battery, packVoltageV: 41.2 },
        },
      }),
    );

    expect(controller.metrics.get("controller.batteryVoltageV")).toEqual([
      { t: expect.any(Number), value: 41.5 },
    ]);
    expect(controller.metrics.get("controller.cadenceRpm")[0]?.value).toBe(60);
    expect(controller.metrics.get("battery.packVoltageV")[0]?.value).toBe(41.2);
  });

  it("records the torque percentage alongside the raw calibration", async () => {
    const controller = new BikeController(fakeHost());
    await controller.connect();
    const bike = controller.bike!;

    bike.dispatchEvent(new CustomEvent<BikeDetail>("detail", { detail: fakeDetail(238) }));
    bike.dispatchEvent(new CustomEvent<BikeDetail>("detail", { detail: fakeDetail(119) }));

    const points = controller.metrics.get("torque.percent");
    expect(points.map((p) => p.value)).toEqual([0, 50]);
  });

  it("distinguishes a live broadcast from a trip broadcast sharing the same telemetry event", async () => {
    // Regression case: both broadcast kinds dispatch the same "telemetry" event, so recording
    // logic must not re-record trip's stale, unchanged fields every time a live broadcast (which
    // arrives far more often) ticks, or vice versa.
    const controller = new BikeController(fakeHost());
    await controller.connect();
    const bike = controller.bike!;

    vi.spyOn(bike, "liveStatus", "get").mockReturnValue(fakeLiveStatus({ speedKmh: 10 }));
    vi.spyOn(bike, "tripStats", "get").mockReturnValue(undefined);
    bike.dispatchEvent(new Event("telemetry"));

    vi.spyOn(bike, "liveStatus", "get").mockReturnValue(fakeLiveStatus({ speedKmh: 10 })); // unchanged value, but a fresh object each decode
    vi.spyOn(bike, "tripStats", "get").mockReturnValue(fakeTripStats({ avgSpeedKmh: 8 }));
    bike.dispatchEvent(new Event("telemetry"));

    expect(controller.metrics.get("hero.speed")).toHaveLength(2); // one per live broadcast
    expect(controller.metrics.get("trip.avgSpeedKmh")).toHaveLength(1); // only the one trip broadcast
  });

  it("clears every metric's history on disconnect", async () => {
    const controller = new BikeController(fakeHost());
    await controller.connect();
    const bike = controller.bike!;

    bike.dispatchEvent(new CustomEvent<BikeDetail>("detail", { detail: fakeDetail(238) }));
    expect(controller.metrics.get("torque.percent")).not.toEqual([]);

    announceState(bike, "disconnected");
    expect(controller.metrics.get("torque.percent")).toEqual([]);
  });
});
