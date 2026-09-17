import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./stat-tile.js";
import type { ControllerDetail, TripStats } from "../../protocol/index.js";

@customElement("trip-odometer-strip")
export class TripOdometerStrip extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 0 var(--space-4);
    }
  `;

  @property({ attribute: false }) detail: ControllerDetail | undefined;
  @property({ attribute: false }) trip: TripStats | undefined;

  override render() {
    const d = this.detail;
    const t = this.trip;
    return html`
      <stat-tile
        label="trip"
        value=${d ? d.tripKm.toFixed(2) : "—"}
        unit="km"
        metricId="controller.tripKm"
      ></stat-tile>
      <stat-tile
        label="odometer"
        value=${d ? d.odometerKm.toFixed(1) : "—"}
        unit="km"
        metricId="controller.odometerKm"
      ></stat-tile>
      <stat-tile
        label="range"
        value=${d?.remainingRangeKm !== undefined ? d.remainingRangeKm.toFixed(0) : "—"}
        unit="km"
        metricId="controller.remainingRangeKm"
      ></stat-tile>
      <stat-tile
        label="avg speed"
        value=${t ? t.avgSpeedKmh.toFixed(1) : "—"}
        unit="km/h"
        metricId="trip.avgSpeedKmh"
      ></stat-tile>
      <stat-tile
        label="max speed"
        value=${t ? t.maxSpeedKmh.toFixed(1) : "—"}
        unit="km/h"
        metricId="trip.maxSpeedKmh"
      ></stat-tile>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "trip-odometer-strip": TripOdometerStrip;
  }
}
