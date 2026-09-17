import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./ado-app.js";
import type { AdoApp } from "./ado-app.js";
import { AdoBike, type BikeProfile } from "../protocol/index.js";
import { announceState, fakeDevice, fakeLiveStatus } from "./test-fixtures.js";

async function mount(): Promise<AdoApp> {
  const el = document.createElement("ado-app") as AdoApp;
  document.body.append(el);
  await el.updateComplete;
  return el;
}

/** Dispatches the click and lets `connect()`'s async chain (incl. reading `.profile`) settle. */
async function connectAndSettle(el: AdoApp): Promise<void> {
  el.dispatchEvent(new Event("connect-requested"));
  await el.updateComplete;
  await el.updateComplete;
}

function tabLabels(el: AdoApp): string[] {
  const tabBar = el.shadowRoot?.querySelector("tab-bar");
  return [...(tabBar?.shadowRoot?.querySelectorAll("button") ?? [])].map(
    (b) => b.textContent?.trim() ?? "",
  );
}

/** The AdoBike mocking every describe block below needs to drive connect() through to "ready" —
 *  `.bike` is set once connect() actually runs, since tests dispatch further events (telemetry,
 *  disconnect) on that specific instance afterward. Each describe adds its own `profile`/
 *  `liveStatus` mocks on top, since those vary per test group. */
function mockConnectableBike(): { bike: AdoBike | undefined } {
  const ref: { bike: AdoBike | undefined } = { bike: undefined };
  vi.spyOn(AdoBike, "getKnownDevices").mockResolvedValue([]);
  vi.spyOn(AdoBike, "requestDevice").mockResolvedValue(fakeDevice("bike-1"));
  vi.spyOn(AdoBike.prototype, "identities", "get").mockReturnValue(undefined);
  vi.spyOn(AdoBike.prototype, "connect").mockImplementation(async function (this: AdoBike) {
    ref.bike = this;
    announceState(this, "ready");
  });
  return ref;
}

describe("<ado-app> — tab visibility by connection state", () => {
  let bikeRef: { bike: AdoBike | undefined };

  beforeEach(() => {
    bikeRef = mockConnectableBike();
    vi.spyOn(AdoBike.prototype, "profile", "get").mockReturnValue(undefined);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("shows only about/sessions while disconnected, not live/battery/info", async () => {
    const el = await mount();
    expect(tabLabels(el)).toEqual(["about", "sessions"]);
  });

  it("shows live/battery/info/sessions once connected, and hides about", async () => {
    const el = await mount();
    await connectAndSettle(el);

    expect(tabLabels(el)).toEqual(["live", "battery", "info", "sessions"]);
  });

  it("falls back to a valid tab once the current one is no longer offered", async () => {
    const el = await mount();
    await connectAndSettle(el);

    // Switch to "battery", then disconnect — "battery" isn't offered while disconnected.
    const tabBar = el.shadowRoot!.querySelector("tab-bar")!;
    const batteryButton = [...tabBar.shadowRoot!.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "battery",
    );
    batteryButton?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await el.updateComplete;

    announceState(bikeRef.bike!, "disconnected");
    await el.updateComplete;

    expect(tabLabels(el)).toEqual(["about", "sessions"]);
    // "about" is actually selected, not just offered.
    expect(el.shadowRoot?.querySelector("about-tab")).not.toBeNull();
  });

  it("keeps sessions reachable in both states", async () => {
    const el = await mount();
    expect(tabLabels(el)).toContain("sessions");

    await connectAndSettle(el);
    expect(tabLabels(el)).toContain("sessions");
  });
});

describe("<ado-app> — battery online indicator", () => {
  let bikeRef: { bike: AdoBike | undefined };

  beforeEach(() => {
    bikeRef = mockConnectableBike();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("shows offline when the profile trusts the bit and the bike reports offline", async () => {
    const trustingProfile = { batteryOnlineBitTrusted: true } as BikeProfile;
    vi.spyOn(AdoBike.prototype, "profile", "get").mockReturnValue(trustingProfile);
    vi.spyOn(AdoBike.prototype, "liveStatus", "get").mockReturnValue(
      fakeLiveStatus({ batteryMain: { percentage: 100, online: false } }),
    );

    const el = await mount();
    await connectAndSettle(el);
    bikeRef.bike!.dispatchEvent(new Event("telemetry"));
    await el.updateComplete;

    const hero = el.shadowRoot?.querySelector("battery-hero");
    expect((hero as unknown as { online: boolean } | null)?.online).toBe(false);
  });

  it("ignores a false online bit when the profile says it isn't trustworthy", async () => {
    const untrustingProfile = { batteryOnlineBitTrusted: false } as BikeProfile;
    vi.spyOn(AdoBike.prototype, "profile", "get").mockReturnValue(untrustingProfile);
    vi.spyOn(AdoBike.prototype, "liveStatus", "get").mockReturnValue(
      fakeLiveStatus({ batteryMain: { percentage: 100, online: false } }),
    );

    const el = await mount();
    await connectAndSettle(el);
    bikeRef.bike!.dispatchEvent(new Event("telemetry"));
    await el.updateComplete;

    const hero = el.shadowRoot?.querySelector("battery-hero");
    expect((hero as unknown as { online: boolean } | null)?.online).toBe(true);
  });
});

describe("<ado-app> — click-to-graph modal", () => {
  let bikeRef: { bike: AdoBike | undefined };

  beforeEach(() => {
    bikeRef = mockConnectableBike();
    vi.spyOn(AdoBike.prototype, "profile", "get").mockReturnValue(undefined);
    vi.spyOn(AdoBike.prototype, "liveStatus", "get").mockReturnValue(fakeLiveStatus());
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("opens the chart modal, with the tile's own label/unit, when a stat-tile is clicked", async () => {
    const el = await mount();
    await connectAndSettle(el);
    bikeRef.bike!.dispatchEvent(new Event("telemetry"));
    await el.updateComplete;

    expect(el.shadowRoot?.querySelector("metric-chart-modal")).toBeNull();

    const speedHero = el.shadowRoot?.querySelector("speed-hero");
    const heroReadout = speedHero?.shadowRoot?.querySelector("hero-readout");
    heroReadout?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await el.updateComplete;

    const modal = el.shadowRoot?.querySelector("metric-chart-modal");
    expect(modal).not.toBeNull();
    expect((modal as unknown as { metricId: string } | null)?.metricId).toBe("hero.speed");
    expect((modal as unknown as { label: string } | null)?.label).toBe("speed");
  });

  it("closes the modal when it dispatches metric-chart-close", async () => {
    const el = await mount();
    await connectAndSettle(el);
    bikeRef.bike!.dispatchEvent(new Event("telemetry"));
    await el.updateComplete;

    const speedHero = el.shadowRoot?.querySelector("speed-hero");
    const heroReadout = speedHero?.shadowRoot?.querySelector("hero-readout");
    heroReadout?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("metric-chart-modal")).not.toBeNull();

    el.shadowRoot
      ?.querySelector("metric-chart-modal")
      ?.dispatchEvent(new Event("metric-chart-close", { bubbles: true, composed: true }));
    await el.updateComplete;

    expect(el.shadowRoot?.querySelector("metric-chart-modal")).toBeNull();
  });
});
