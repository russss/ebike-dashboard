import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ClickableMetricTile } from "./clickable-metric-tile.js";

export type Tone = "nominal" | "caution" | "fault";

/**
 * One instrument row: a quiet left-aligned label, a right-aligned tabular value + unit.
 * Clickability (opening a history graph) comes from `ClickableMetricTile` — see there; tiles
 * with no time series behind them (identity strings, the combined "cells" readout) simply don't
 * get a `metricId` and stay inert.
 */
@customElement("stat-tile")
export class StatTile extends ClickableMetricTile(LitElement) {
  static override styles = css`
    :host {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-2) 0;
      border-bottom: 1px solid var(--hairline);
    }
    :host(:last-child) {
      border-bottom: none;
    }
    :host([clickable]) {
      cursor: pointer;
    }
    :host([clickable]:hover) .value {
      color: var(--accent);
    }
    .label {
      color: var(--fg-dim);
      font-size: 13px;
    }
    .value-group {
      display: flex;
      align-items: baseline;
      gap: 4px;
      white-space: nowrap;
    }
    .value {
      font-size: 16px;
      font-weight: 500;
    }
    .unit {
      color: var(--fg-dim);
      font-size: 12px;
    }
    :host([tone="nominal"]) .value {
      color: var(--nominal);
    }
    :host([tone="caution"]) .value {
      color: var(--caution);
    }
    :host([tone="fault"]) .value {
      color: var(--fault);
    }
  `;

  @property() label = "";
  @property() value = "";
  @property() unit = "";
  @property({ reflect: true }) tone: Tone | "" = "";
  /** When set, this tile is clickable and opens its history graph — see `ClickableMetricTile`. */
  @property() metricId = "";

  override render() {
    return html`
      <span class="label">${this.label}</span>
      <span class="value-group">
        <span class="value tabular">${this.value}</span>
        ${this.unit ? html`<span class="unit">${this.unit}</span>` : null}
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "stat-tile": StatTile;
  }
}
