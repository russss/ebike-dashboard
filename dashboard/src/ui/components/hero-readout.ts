import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./sparkline-chart.js";
import { ClickableMetricTile } from "./clickable-metric-tile.js";
import type { Tone } from "./stat-tile.js";

/**
 * Speed/battery/assist level — deliberately *not* a big PFD-style hero number. All three are
 * already shown on the bike's own controller display, so this dashboard treats them as a
 * glanceable trend tile (value + sparkline) rather than the thing you're meant to stare at.
 * Clickability comes from `ClickableMetricTile` — see there.
 */
@customElement("hero-readout")
export class HeroReadout extends ClickableMetricTile(LitElement) {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      min-width: 72px;
    }
    .value {
      line-height: 1;
      font-weight: 600;
      color: var(--fg);
      font-size: 26px;
      font-variant-numeric: tabular-nums;
    }
    .unit {
      color: var(--fg-dim);
      font-size: 12px;
      margin-top: 1px;
    }
    .label {
      color: var(--fg-dim);
      font-size: 11px;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    :host([tone="caution"]) .value {
      color: var(--caution);
    }
    :host([tone="fault"]) .value {
      color: var(--fault);
    }
    :host([clickable]) {
      cursor: pointer;
    }
    :host([clickable]:hover) .value {
      color: var(--accent);
    }
  `;

  @property() value = "0";
  @property() unit = "";
  @property() label = "";
  @property({ reflect: true }) tone: Tone | "" = "";
  @property({ type: Array }) history: number[] = [];
  /** When set, this tile is clickable and opens its history graph — see `ClickableMetricTile`. */
  @property() metricId = "";

  override render() {
    return html`
      <span class="label">${this.label}</span>
      <span class="value">${this.value}</span>
      ${this.unit ? html`<span class="unit">${this.unit}</span>` : null}
      ${this.history.length >= 2 ? html`<sparkline-chart .values=${this.history}></sparkline-chart>` : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hero-readout": HeroReadout;
  }
}
