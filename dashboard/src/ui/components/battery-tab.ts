import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./stat-tile.js";
import type { BatteryDetail, UnavailableBatteryField } from "../../protocol/index.js";

/** Renders `tile`, or nothing if this model's profile has flagged `field` as never populated. */
function ifAvailable(
  hidden: ReadonlySet<UnavailableBatteryField>,
  field: UnavailableBatteryField,
  tile: TemplateResult,
): TemplateResult | null {
  return hidden.has(field) ? null : tile;
}

@customElement("battery-tab")
export class BatteryTab extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: var(--space-4);
    }
    .empty {
      color: var(--fg-dim);
      font-size: 13px;
      text-align: center;
      padding: var(--space-5);
    }
  `;

  @property({ attribute: false }) detail: BatteryDetail | undefined;
  /** Fields this bike's profile has confirmed never carry real data — see `profiles.ts`. */
  @property({ attribute: false }) unavailableFields: ReadonlySet<UnavailableBatteryField> =
    new Set();

  override render() {
    const d = this.detail;
    if (!d) return html`<div class="empty">Waiting for battery data…</div>`;

    const state = d.charging ? "charging" : d.discharging ? "discharging" : "idle";
    const hidden = this.unavailableFields;

    return html`
      <stat-tile
        label="pack voltage"
        value=${d.packVoltageV.toFixed(2)}
        unit="V"
        metricId="battery.packVoltageV"
      ></stat-tile>
      <stat-tile
        label="pack current"
        value=${d.packCurrentA.toFixed(2)}
        unit="A"
        tone=${d.packCurrentA < 0 ? "nominal" : ""}
        metricId="battery.packCurrentA"
      ></stat-tile>
      ${ifAvailable(
        hidden,
        "packTemperatureC",
        html`<stat-tile
          label="pack temp"
          value=${d.packTemperatureC.toFixed(0)}
          unit="°C"
          metricId="battery.packTemperatureC"
        ></stat-tile>`,
      )}
      <stat-tile label="state" value=${state} tone=${d.charging ? "nominal" : ""}></stat-tile>
      ${ifAvailable(
        hidden,
        "chargeOfFullPercent",
        html`<stat-tile
          label="charge, of full capacity"
          value=${d.chargeOfFullPercent}
          unit="%"
          metricId="battery.chargeOfFullPercent"
        ></stat-tile>`,
      )}
      ${ifAvailable(
        hidden,
        "chargeOfDesignPercent",
        html`<stat-tile
          label="charge, of design capacity"
          value=${d.chargeOfDesignPercent}
          unit="%"
          metricId="battery.chargeOfDesignPercent"
        ></stat-tile>`,
      )}
      ${ifAvailable(
        hidden,
        "fullCapacityMah",
        html`<stat-tile
          label="full capacity"
          value=${d.fullCapacityMah}
          unit="mAh"
          metricId="battery.fullCapacityMah"
        ></stat-tile>`,
      )}
      ${ifAvailable(
        hidden,
        "remainingCapacityMah",
        html`<stat-tile
          label="remaining capacity"
          value=${d.remainingCapacityMah}
          unit="mAh"
          metricId="battery.remainingCapacityMah"
        ></stat-tile>`,
      )}
      ${ifAvailable(
        hidden,
        "cells",
        html`<stat-tile label="cells" value="${d.cellsInSeries}s ${d.cellsInParallel}p"></stat-tile>`,
      )}
      ${ifAvailable(
        hidden,
        "maxChargeVoltageV",
        html`<stat-tile
          label="max charge voltage"
          value=${d.maxChargeVoltageV.toFixed(2)}
          unit="V"
          metricId="battery.maxChargeVoltageV"
        ></stat-tile>`,
      )}
      ${ifAvailable(
        hidden,
        "maxChargeCurrentA",
        html`<stat-tile
          label="max charge current"
          value=${d.maxChargeCurrentA.toFixed(2)}
          unit="A"
          metricId="battery.maxChargeCurrentA"
        ></stat-tile>`,
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "battery-tab": BatteryTab;
  }
}
