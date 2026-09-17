import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./stat-tile.js";
import type { ControllerDetail } from "../../protocol/index.js";

interface Row {
  readonly label: string;
  readonly value: (d: ControllerDetail) => number;
  readonly decimals: number;
  readonly unit: string;
  readonly metricId: string;
}

// Every row here reads one ControllerDetail field the same way (toFixed to a fixed precision) —
// torque is the one exception, sourced from the separately-calibrated torquePercent below.
const ROWS: readonly Row[] = [
  { label: "voltage", value: (d) => d.batteryVoltageV, decimals: 2, unit: "V", metricId: "controller.batteryVoltageV" },
  { label: "current", value: (d) => d.motorCurrentA, decimals: 2, unit: "A", metricId: "controller.motorCurrentA" },
  { label: "power", value: (d) => d.computedPowerW, decimals: 0, unit: "W", metricId: "controller.computedPowerW" },
  { label: "cadence", value: (d) => d.cadenceRpm, decimals: 0, unit: "rpm", metricId: "controller.cadenceRpm" },
];

const TEMPERATURE_ROWS: readonly Row[] = [
  { label: "controller temp", value: (d) => d.controllerTemperatureC, decimals: 0, unit: "°C", metricId: "controller.controllerTemperatureC" },
  { label: "motor temp", value: (d) => d.motorTemperatureC, decimals: 0, unit: "°C", metricId: "controller.motorTemperatureC" },
];

/** Voltage, current, power, cadence, torque, temperatures — the dense instrument row below the hero. */
@customElement("secondary-strip")
export class SecondaryStrip extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 0 var(--space-4);
    }
  `;

  @property({ attribute: false }) detail: ControllerDetail | undefined;
  /** Normalised against the highest torque-sensor voltage seen this connection — see `torque.ts`. */
  @property({ attribute: false }) torquePercent: number | undefined;

  #renderRow(d: ControllerDetail | undefined, row: Row) {
    return html`
      <stat-tile
        label=${row.label}
        value=${d ? row.value(d).toFixed(row.decimals) : "—"}
        unit=${row.unit}
        metricId=${row.metricId}
      ></stat-tile>
    `;
  }

  override render() {
    const d = this.detail;
    return html`
      ${ROWS.map((row) => this.#renderRow(d, row))}
      <stat-tile
        label="torque"
        value=${this.torquePercent !== undefined ? this.torquePercent.toFixed(0) : "—"}
        unit="%"
        metricId="torque.percent"
      ></stat-tile>
      ${TEMPERATURE_ROWS.map((row) => this.#renderRow(d, row))}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "secondary-strip": SecondaryStrip;
  }
}
