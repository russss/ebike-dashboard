import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { BikeController } from "./controllers/bike-controller.js";
import { WakeLockController } from "./controllers/wake-lock-controller.js";
import "./components/connection-bar.js";
import "./components/status-row.js";
import "./components/tab-bar.js";
import "./components/speed-hero.js";
import "./components/battery-hero.js";
import "./components/assist-hero.js";
import "./components/secondary-strip.js";
import "./components/trip-odometer-strip.js";
import "./components/identity-tab.js";
import "./components/battery-tab.js";
import "./components/sessions-tab.js";
import "./components/about-tab.js";
import "./components/metric-chart-modal.js";
import type { TabDefinition } from "./components/tab-bar.js";
import type { MetricSelectedDetail } from "./components/metric-selected-event.js";

type TabId = "live" | "battery" | "info" | "sessions" | "about";

// Live/battery/info only make sense once there's an actual bike to show data for; "about" only
// makes sense before there's one to connect to. "sessions" — past rides recorded on this device
// — is useful either way, so it appears in both lists.
const CONNECTED_TABS: readonly TabDefinition[] = [
  { id: "live", label: "live" },
  { id: "battery", label: "battery" },
  { id: "info", label: "info" },
  { id: "sessions", label: "sessions" },
];
const DISCONNECTED_TABS: readonly TabDefinition[] = [
  { id: "about", label: "about" },
  { id: "sessions", label: "sessions" },
];

@customElement("ado-app")
export class AdoApp extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100svh;
    }
    .hero-block {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-4);
    }
    .hero-row {
      display: flex;
      gap: var(--space-5);
    }
    .section-gap {
      height: var(--space-4);
    }
    .idle {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      padding: var(--space-5);
      text-align: center;
      color: var(--fg-dim);
      font-size: 14px;
    }
    .error {
      margin: 0 var(--space-4);
      padding: var(--space-3);
      border-radius: 4px;
      background: var(--fault-bg);
      color: var(--fault);
      font-size: 13px;
    }
    .tab-panel {
      flex: 1;
    }
  `;

  #bike = new BikeController(this);

  @state() private activeTab: TabId = "live";
  @state() private selectedMetric: MetricSelectedDetail | undefined;

  constructor() {
    super();
    // No field to hold onto: it registers itself with this host via addController() and runs
    // its whole lifecycle through hostConnected()/hostDisconnected() — nothing here ever needs
    // to read anything back from it.
    new WakeLockController(this);
  }

  private handleConnectRequested = async (): Promise<void> => {
    try {
      await this.#bike.connect();
    } catch {
      // BikeController already captured the message in this.#bike.error and triggered a re-render.
    }
  };

  private handleDisconnectRequested = (): void => {
    void this.#bike.disconnect();
  };

  private handleTabSelected = (event: Event): void => {
    this.activeTab = (event as CustomEvent<TabId>).detail;
  };

  private handleMetricSelected = (event: Event): void => {
    this.selectedMetric = (event as CustomEvent<MetricSelectedDetail>).detail;
  };

  private handleMetricModalClose = (): void => {
    this.selectedMetric = undefined;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("connect-requested", this.handleConnectRequested as EventListener);
    this.addEventListener("disconnect-requested", this.handleDisconnectRequested);
    this.addEventListener("tab-selected", this.handleTabSelected as EventListener);
    this.addEventListener("metric-selected", this.handleMetricSelected as EventListener);
    this.addEventListener("metric-chart-close", this.handleMetricModalClose);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("connect-requested", this.handleConnectRequested as EventListener);
    this.removeEventListener("disconnect-requested", this.handleDisconnectRequested);
    this.removeEventListener("tab-selected", this.handleTabSelected as EventListener);
    this.removeEventListener("metric-selected", this.handleMetricSelected as EventListener);
    this.removeEventListener("metric-chart-close", this.handleMetricModalClose);
  }

  override render() {
    const { state, live, trip, detail, identities, profile, history, torquePercent, error } =
      this.#bike;
    // "unsupported-model" still gets live status broadcasts and identity — see the
    // ConnectionState JSDoc in protocol/types.ts — only per-model detail reads are gated.
    const ready =
      state === "ready" || state === "lockup-suspected" || state === "unsupported-model";

    const tabs = ready ? CONNECTED_TABS : DISCONNECTED_TABS;
    // Falls back to this list's own first tab rather than staying on one that's no longer
    // offered — e.g. connecting swaps "about" for "live", disconnecting swaps back. The cast is
    // safe: every id in CONNECTED_TABS/DISCONNECTED_TABS is a literal drawn from TabId itself.
    const activeTab = tabs.some((t) => t.id === this.activeTab)
      ? this.activeTab
      : (tabs[0]!.id as TabId);

    return html`
      <connection-bar
        .connectionState=${state}
        .deviceName=${identities?.meter.model ?? ""}
      ></connection-bar>

      ${error ? html`<div class="error">${error}</div>` : null}

      <status-row .connectionState=${state} .liveStatus=${live}></status-row>

      <tab-bar .tabs=${tabs} active=${activeTab}></tab-bar>
      <div class="tab-panel">
        ${activeTab === "sessions"
          ? html`<sessions-tab></sessions-tab>`
          : activeTab === "about"
            ? html`<about-tab></about-tab>`
            : ready && live
              ? this.#renderTab(activeTab, {
                  live,
                  trip,
                  detail,
                  identities,
                  profile,
                  history,
                  torquePercent,
                })
              : html`
                  <div class="idle">
                    <p>Waiting for the bike…</p>
                  </div>
                `}
      </div>

      ${this.selectedMetric
        ? html`<metric-chart-modal
            .metricId=${this.selectedMetric.metricId}
            .label=${this.selectedMetric.label}
            .unit=${this.selectedMetric.unit}
            .decimals=${this.selectedMetric.decimals}
            .points=${this.#bike.metrics.get(this.selectedMetric.metricId)}
          ></metric-chart-modal>`
        : null}
    `;
  }

  #renderTab(
    tab: TabId,
    data: Pick<
      BikeController,
      "live" | "trip" | "detail" | "identities" | "profile" | "history" | "torquePercent"
    >,
  ) {
    const { live, trip, detail, identities, profile, history, torquePercent } = data;
    if (!live) return null;

    switch (tab) {
      case "battery":
        return html`<battery-tab
          .detail=${detail?.battery}
          .unavailableFields=${profile?.unavailableBatteryFields ?? new Set()}
        ></battery-tab>`;
      case "info":
        return html`<identity-tab
          .identities=${identities}
          .profile=${profile}
          .controller=${detail?.controller}
        ></identity-tab>`;
      case "live":
      default: {
        const speedHistory = history.map((s) => s.speedKmh);
        const batteryHistory = history.map((s) => s.batteryPercent);
        const assistHistory = history.map((s) => s.assistLevel);
        // Showing "offline" next to a battery that's plainly connected and reporting a real
        // charge level is worse than showing nothing — see BikeProfile.batteryOnlineBitTrusted.
        const batteryOnline = profile?.batteryOnlineBitTrusted === false || live.batteryMain.online;
        return html`
          <div class="hero-block">
            <div class="hero-row">
              <speed-hero
                .speedKmh=${detail?.controller.speedKmh ?? live.speedKmh}
                .history=${speedHistory}
              ></speed-hero>
              <battery-hero
                .percent=${live.batteryMain.percentage}
                .online=${batteryOnline}
                .history=${batteryHistory}
              ></battery-hero>
              <assist-hero
                .level=${live.assistLevel}
                .levels=${live.assistLevels}
                .history=${assistHistory}
              ></assist-hero>
            </div>
          </div>
          <secondary-strip .detail=${detail?.controller} .torquePercent=${torquePercent}></secondary-strip>
          <div class="section-gap"></div>
          <trip-odometer-strip .detail=${detail?.controller} .trip=${trip}></trip-odometer-strip>
        `;
      }
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ado-app": AdoApp;
  }
}
