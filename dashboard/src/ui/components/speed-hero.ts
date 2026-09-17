import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./hero-readout.js";

@customElement("speed-hero")
export class SpeedHero extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
  `;

  @property({ type: Number }) speedKmh = 0;
  @property({ type: Array }) history: number[] = [];

  override render() {
    return html`
      <hero-readout
        value=${this.speedKmh.toFixed(1)}
        unit="km/h"
        label="speed"
        metricId="hero.speed"
        .history=${this.history}
      ></hero-readout>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "speed-hero": SpeedHero;
  }
}
