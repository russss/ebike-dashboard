/** Shared fakes for tests that drive a `BikeController`/`AdoApp` through a mocked `AdoBike`. */
import type {
  AdoBike,
  BikeDetail,
  ConnectionState,
  LiveStatus,
  TripStats,
} from "../protocol/index.js";

export function fakeDevice(name: string): BluetoothDevice {
  return { name } as BluetoothDevice;
}

/** Mimics the one bit of `AdoBike.connect()`'s real contract these tests rely on: state changes
 *  are announced as `connectionstatechange` events on the bike itself, not returned values. */
export function announceState(bike: AdoBike, state: ConnectionState): void {
  bike.dispatchEvent(new CustomEvent<ConnectionState>("connectionstatechange", { detail: state }));
}

export function fakeLiveStatus(overrides: Partial<LiveStatus> = {}): LiveStatus {
  return {
    faultCode: 0,
    batterySecondary: { percentage: 0, online: false },
    batteryMain: { percentage: 0, online: false },
    activeBattery: 0,
    headlightOn: false,
    assistLevel: 0,
    assistLevels: 0,
    workingMode: 0,
    speedKmh: 0,
    tripKm: 0,
    odometerKm: 0,
    calories: 0,
    ...overrides,
  };
}

export function fakeTripStats(overrides: Partial<TripStats> = {}): TripStats {
  return {
    durationS: 0,
    avgSpeedKmh: 0,
    maxSpeedKmh: 0,
    backlightLevel: 0,
    unitMiles: false,
    totalRideS: 0,
    ...overrides,
  };
}

export function fakeBikeDetail(torqueSignalMv: number): BikeDetail {
  return {
    controller: {
      batteryPercent: 0,
      tripKm: 0,
      odometerKm: 0,
      remainingRangeKm: undefined,
      cadenceRpm: 0,
      torqueSignalMv,
      speedKmh: 0,
      motorCurrentA: 0,
      batteryVoltageV: 0,
      controllerTemperatureC: 0,
      motorTemperatureC: 0,
      boostActive: false,
      speedLimitKmh: 0,
      wheelDiameterInches: 0,
      tyreCircumferenceMm: 0,
      calories: 0,
      wheelSpeedRpm: 0,
      computedPowerW: 0,
    },
    battery: {
      fullCapacityMah: 0,
      remainingCapacityMah: 0,
      chargeOfFullPercent: 0,
      chargeOfDesignPercent: 0,
      packCurrentA: 0,
      packVoltageV: 0,
      packTemperatureC: 0,
      heaterActive: false,
      charging: false,
      discharging: false,
      cellsInSeries: 0,
      cellsInParallel: 0,
      maxChargeVoltageV: 0,
      maxChargeCurrentA: 0,
    },
    meter: {
      assistLevelCount: 0,
      sportMode: 0,
      backlightLevel: 0,
      tripKm: 0,
      distanceSinceServiceKm: 0,
      autoOffTimeMin: 0,
      totalRideTimeMin: 0,
      totalCalories: 0,
    },
  };
}
