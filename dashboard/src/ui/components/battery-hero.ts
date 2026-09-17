import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./hero-readout.js";
import type { Tone } from "./stat-tile.js";

@customElement("battery-hero")
export class BatteryHero extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
  `;

  @property({ type: Number }) percent = 0;
  @property({ type: Boolean }) online = true;
  @property({ type: Array }) history: number[] = [];

  private get tone(): Tone | "" {
    if (this.percent <= 10) return "fault";
    if (this.percent <= 25) return "caution";
    return "";
  }

  override render() {
    return html`
      <hero-readout
        value=${Math.round(this.percent)}
        unit="%"
        label=${this.online ? "battery" : "battery (offline)"}
        tone=${this.tone}
        metricId="hero.batteryPercent"
        .history=${this.history}
      ></hero-readout>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "battery-hero": BatteryHero;
  }
}
